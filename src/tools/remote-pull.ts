import fs from "fs/promises"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"

const DEFAULT_WARN_BYTES = 25 * 1024 * 1024
const DEFAULT_WARN_FILES = 500
const REMOTE_FIND_TIMEOUT_MS = 120_000
const CONFIRMATION_TTL_MS = 10 * 60 * 1000

const pendingConfirmations = new Map<string, number>()

interface RemotePullPlan {
  remotePath: string
  type: "file" | "directory"
  bytes: number
  files: number
  directories: number
  localPath: string
}

interface RemoteStat {
  type: "file" | "directory" | "missing"
  bytes: number
  files: number
  directories: number
}

export function createRemotePullTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_pull",
    {
      description: `Download a remote file or directory to an explicitly provided absolute local path. Large transfers return a size warning first and require force=true on a second call.`,
      inputSchema: {
        machine: z.string().optional().describe("Name of the remote machine. If omitted and only one machine is connected, uses that machine."),
        remotePath: z.string().describe("The absolute remote file or directory path to download."),
        localPath: z.string().describe("The absolute local destination path. For files this is the target file path; for directories this is the target directory path."),
        force: z.boolean().optional().describe("Set true only after a large-transfer warning to confirm the download."),
      },
    },
    async ({ machine, remotePath: remotePathArg, localPath: localPathArg, force }) => {
      const conn = connectionManager.get(machine)
      if (!conn) {
        return {
          content: [
            {
              type: "text" as const,
              text: machine
                ? `Connection "${machine}" not found. Use remote_list_machines to see available connections.`
                : "No remote machines connected. Use remote_connect to connect, or specify a machine name.",
            },
          ],
        }
      }

      const remotePath = normalizeRemotePath(remotePathArg)
      if (!remotePath) {
        return {
          content: [
            {
              type: "text" as const,
              text: `remote_pull remotePath must be an absolute remote path, got: ${remotePathArg}`,
            },
          ],
        }
      }

      const localPath = normalizeLocalPath(localPathArg)
      if (!localPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: `remote_pull localPath must be an absolute local path, got: ${localPathArg}`,
            },
          ],
        }
      }

      const stat = await statRemotePath(conn.sshPool, remotePath)

      if (stat.type === "missing") {
        return {
          content: [
            {
              type: "text" as const,
              text: `[${conn.name}] Remote path not found: ${remotePath}`,
            },
          ],
        }
      }

      const plan: RemotePullPlan = {
        remotePath,
        type: stat.type,
        bytes: stat.bytes,
        files: stat.files,
        directories: stat.directories,
        localPath,
      }

      const warnBytes = parsePositiveInt(process.env.REMOTE_PULL_WARN_BYTES, DEFAULT_WARN_BYTES)
      const warnFiles = parsePositiveInt(process.env.REMOTE_PULL_WARN_FILES, DEFAULT_WARN_FILES)
      const isLarge = plan.bytes > warnBytes || plan.files > warnFiles
      const confirmationKey = buildConfirmationKey(conn.name, plan)

      if (isLarge && !hasFreshConfirmation(confirmationKey)) {
        pendingConfirmations.set(confirmationKey, Date.now() + CONFIRMATION_TTL_MS)
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[${conn.name}] Pull requires confirmation.`,
                "",
                renderPlan(plan),
                "",
                `Warning: this transfer exceeds the large-transfer threshold (${formatBytes(warnBytes)} or ${warnFiles} files).`,
                `Run remote_pull again with the same remotePath/localPath and force=true within 10 minutes to download it.`,
              ].join("\n"),
            },
          ],
        }
      }
      if (isLarge && !force) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `[${conn.name}] Pull is preflighted but not confirmed.`,
                "",
                renderPlan(plan),
                "",
                `Run remote_pull again with force=true to download it.`,
              ].join("\n"),
            },
          ],
        }
      }
      pendingConfirmations.delete(confirmationKey)

      if (plan.type === "file") {
        await pullFile(conn.sshPool, plan.remotePath, plan.localPath)
      } else {
        await pullDirectory(conn.sshPool, plan.remotePath, plan.localPath)
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `[${conn.name}] Pulled remote ${plan.type} successfully.`,
              "",
              renderPlan(plan),
            ].join("\n"),
          },
        ],
      }
    }
  )
}

function normalizeRemotePath(rawPath: string): string | undefined {
  const remotePath = path.posix.normalize(rawPath)
  if (!path.posix.isAbsolute(remotePath)) {
    return undefined
  }
  return remotePath
}

function normalizeLocalPath(rawPath: string): string | undefined {
  if (!isFullyQualifiedLocalAbsolute(rawPath)) {
    return undefined
  }
  return path.resolve(rawPath)
}

function isFullyQualifiedLocalAbsolute(rawPath: string): boolean {
  if (!path.isAbsolute(rawPath)) {
    return false
  }

  if (process.platform !== "win32") {
    return true
  }

  const root = path.win32.parse(rawPath).root
  return /^[a-zA-Z]:[\\/]$/.test(root) || root.startsWith("\\\\")
}

async function statRemotePath(sshPool: any, remotePath: string): Promise<RemoteStat> {
  const quoted = quoteShell(remotePath)
  const command = `
if [ -d ${quoted} ]; then
  sizes=$(find ${quoted} -type f -exec wc -c {} \\; 2>/dev/null | awk 'BEGIN{s=0;c=0} {s+=$1;c++} END{printf "%.0f\\t%d", s, c}')
  dirs=$(find ${quoted} -type d 2>/dev/null | wc -l | tr -d ' ')
  printf 'DIR\\t%s\\t%s\\n' "$sizes" "$dirs"
elif [ -f ${quoted} ]; then
  bytes=$(wc -c < ${quoted} | tr -d ' ')
  printf 'FILE\\t%s\\t1\\t0\\n' "$bytes"
else
  printf 'MISSING\\t0\\t0\\t0\\n'
fi
`
  const result = await sshPool.exec(command, { timeout: REMOTE_FIND_TIMEOUT_MS })
  const line = result.stdout.trim().split("\n").find(Boolean)
  if (!line) {
    throw new Error(`remote_pull failed to stat ${remotePath}: ${result.stderr || "no output"}`)
  }

  const fields = line.split("\t")
  if (fields[0] === "MISSING") {
    return { type: "missing", bytes: 0, files: 0, directories: 0 }
  }
  if (fields[0] === "FILE") {
    return {
      type: "file",
      bytes: parseInt(fields[1] || "0", 10),
      files: parseInt(fields[2] || "1", 10),
      directories: parseInt(fields[3] || "0", 10),
    }
  }
  if (fields[0] === "DIR") {
    return {
      type: "directory",
      bytes: parseInt(fields[1] || "0", 10),
      files: parseInt(fields[2] || "0", 10),
      directories: parseInt(fields[3] || "0", 10),
    }
  }

  throw new Error(`remote_pull failed to parse stat output for ${remotePath}: ${line}`)
}

async function pullFile(sshPool: any, remotePath: string, localPath: string): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true })
  await sshPool.withSftp(async (sftp: any) => {
    await sftpFastGet(sftp, remotePath, localPath)
  })
}

async function pullDirectory(sshPool: any, remotePath: string, localPath: string): Promise<void> {
  const [dirs, files] = await Promise.all([
    listRemotePaths(sshPool, remotePath, "d"),
    listRemotePaths(sshPool, remotePath, "f"),
  ])

  await fs.mkdir(localPath, { recursive: true })
  for (const dir of dirs) {
    await fs.mkdir(localChildPath(remotePath, dir, localPath), { recursive: true })
  }

  await sshPool.withSftp(async (sftp: any) => {
    for (const file of files) {
      const target = localChildPath(remotePath, file, localPath)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await sftpFastGet(sftp, file, target)
    }
  })
}

async function listRemotePaths(
  sshPool: any,
  remotePath: string,
  type: "d" | "f"
): Promise<string[]> {
  const result = await sshPool.exec(
    `find ${quoteShell(remotePath)} -type ${type} -print0`,
    { timeout: REMOTE_FIND_TIMEOUT_MS }
  )
  return result.stdout.split("\0").filter(Boolean)
}

function localChildPath(remoteBase: string, remoteChild: string, localBase: string): string {
  const relative = path.posix.relative(remoteBase, remoteChild)
  if (relative === "") {
    return localBase
  }
  if (relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    throw new Error(`remote_pull received path outside requested directory: ${remoteChild}`)
  }

  const segments = relative.split("/")
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("\\") || path.isAbsolute(segment)) {
      throw new Error(`remote_pull received unsafe remote path segment: ${remoteChild}`)
    }
  }

  const resolved = path.resolve(localBase, ...segments)
  const base = path.resolve(localBase)
  const back = path.relative(base, resolved)
  if (back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(`remote_pull resolved a path outside the local destination: ${remoteChild}`)
  }
  return resolved
}

function sftpFastGet(
  sftp: any,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err: Error | undefined) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function hasFreshConfirmation(key: string): boolean {
  const expiresAt = pendingConfirmations.get(key)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    pendingConfirmations.delete(key)
    return false
  }
  return true
}

function buildConfirmationKey(machine: string, plan: RemotePullPlan): string {
  return [
    machine,
    plan.remotePath,
    plan.localPath,
    plan.type,
    plan.bytes,
    plan.files,
    plan.directories,
  ].join("\0")
}

function renderPlan(plan: RemotePullPlan): string {
  return [
    `Remote: ${plan.remotePath}`,
    `Type: ${plan.type}`,
    `Size: ${formatBytes(plan.bytes)} (${plan.bytes} bytes)`,
    `Files: ${plan.files}`,
    plan.type === "directory" ? `Directories: ${plan.directories}` : undefined,
    `Local destination: ${plan.localPath}`,
  ].filter(Boolean).join("\n")
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`
}
