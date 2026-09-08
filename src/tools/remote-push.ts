import fs from "fs/promises"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { checkConfirmation } from "../confirmation.js"
import { quoteShell } from "../shell-quote.js"
// The same atomic put the sync engine uses. Push previously had its own plain
// fastPut (review F-29, and F-12 left incomplete for push): it wrote through a
// symlinked destination instead of replacing it, and truncated the target if
// the transfer failed partway.
import { sftpFastPut } from "../sync-engine.js"
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js"

const DEFAULT_WARN_BYTES = 25 * 1024 * 1024
const DEFAULT_WARN_FILES = 500

interface RemotePushPlan {
  localPath: string
  remotePath: string
  type: "file" | "directory"
  bytes: number
  files: number
  directories: number
}

interface LocalStat {
  type: "file" | "directory" | "missing" | "unsupported"
  bytes: number
  files: number
  directories: number
}

interface LocalTree {
  bytes: number
  files: string[]
  directories: string[]
}

export function createRemotePushTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_push",
    {
      description: `Upload a local file or directory to an explicitly provided absolute remote path within the configured root. Large transfers return a size warning first and require force=true on a second call.`,
      inputSchema: {
        target: targetSchema,
        localPath: z.string().describe("The absolute local source file or directory path to upload."),
        remotePath: z.string().describe("The remote destination path (absolute or relative to root). For files this is the target file path; for directories this is the target directory path."),
        force: z.boolean().optional().describe("Set true only after a large-transfer warning to confirm the upload."),
      },
    },
    async ({ target, localPath: localPathArg, remotePath: remotePathArg, force }) => {
      const connOrError = await requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const localPath = normalizeLocalPath(localPathArg)
      if (!localPath) {
        return textResult(`remote_push localPath must be an absolute local path, got: ${localPathArg}`)
      }

      const jailed = await jailRemotePath(conn, remotePathArg, { forNewFile: true, allowMissing: true })
      if ("errorText" in jailed) {
        return textResult(jailed.errorText)
      }
      const remotePath = jailed.path

      const stat = await statLocalPath(localPath)
      if (stat.type === "missing") {
        return textResult(`Local path not found: ${localPath}`)
      }
      if (stat.type === "unsupported") {
        return textResult(
          `Unsupported local path type: ${localPath}. remote_push supports regular files and directories.`
        )
      }

      const plan: RemotePushPlan = {
        localPath,
        remotePath,
        type: stat.type,
        bytes: stat.bytes,
        files: stat.files,
        directories: stat.directories,
      }

      const warnBytes = parsePositiveInt(process.env.REMOTE_PUSH_WARN_BYTES, DEFAULT_WARN_BYTES)
      const warnFiles = parsePositiveInt(process.env.REMOTE_PUSH_WARN_FILES, DEFAULT_WARN_FILES)
      const isLarge = plan.bytes > warnBytes || plan.files > warnFiles
      const confirmationKey = buildConfirmationKey(plan)
      const outcome = checkConfirmation(
        confirmationKey,
        isLarge,
        force,
        () =>
          [
            "Push requires confirmation.",
            "",
            renderPlan(plan),
            "",
            `Warning: this transfer exceeds the large-transfer threshold (${formatBytes(warnBytes)} or ${warnFiles} files).`,
            `Run remote_push again with the same localPath/remotePath and force=true within 10 minutes to upload it.`,
          ].join("\n"),
        () =>
          [
            "Push is preflighted but not confirmed.",
            "",
            renderPlan(plan),
            "",
            `Run remote_push again with force=true to upload it.`,
          ].join("\n")
      )

      if (outcome.status === "pending" || outcome.status === "needs_force") {
        return textResult(outcome.message)
      }

      if (plan.type === "file") {
        await pushFile(conn.sshPool, plan.localPath, plan.remotePath)
      } else {
        await pushDirectory(conn.sshPool, plan.localPath, plan.remotePath)
      }

      return textResult([`Pushed local ${plan.type} successfully.`, "", renderPlan(plan)].join("\n"))
    }
  )
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

function buildConfirmationKey(plan: RemotePushPlan): string {
  return [
    plan.localPath,
    plan.remotePath,
    plan.type,
    plan.bytes,
    plan.files,
    plan.directories,
  ].join("\0")
}

function renderPlan(plan: RemotePushPlan): string {
  return [
    `Local source: ${plan.localPath}`,
    `Remote destination: ${plan.remotePath}`,
    `Type: ${plan.type}`,
    `Size: ${formatBytes(plan.bytes)} (${plan.bytes} bytes)`,
    `Files: ${plan.files}`,
    plan.type === "directory" ? `Directories: ${plan.directories}` : undefined,
  ].filter(Boolean).join("\n")
}

async function statLocalPath(localPath: string): Promise<LocalStat> {
  let stats
  try {
    stats = await fs.stat(localPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { type: "missing", bytes: 0, files: 0, directories: 0 }
    }
    throw err
  }

  if (stats.isFile()) {
    return { type: "file", bytes: stats.size, files: 1, directories: 0 }
  }
  if (stats.isDirectory()) {
    const tree = await scanLocalDirectory(localPath)
    return {
      type: "directory",
      bytes: tree.bytes,
      files: tree.files.length,
      directories: tree.directories.length,
    }
  }
  return { type: "unsupported", bytes: 0, files: 0, directories: 0 }
}

async function scanLocalDirectory(localPath: string): Promise<LocalTree> {
  const directories: string[] = [localPath]
  const files: string[] = []
  let bytes = 0

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        directories.push(child)
        await walk(child)
      } else if (entry.isFile()) {
        files.push(child)
        const stat = await fs.stat(child)
        bytes += stat.size
      }
    }
  }

  await walk(localPath)
  return { bytes, files, directories }
}

async function pushFile(sshPool: any, localPath: string, remotePath: string): Promise<void> {
  const remoteDir = path.posix.dirname(remotePath)
  await sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { retry: true, timeout: 10_000 })
  await sshPool.withSftp(async (sftp: any) => {
    await sftpFastPut(sftp, localPath, remotePath)
  })
}

async function pushDirectory(sshPool: any, localPath: string, remotePath: string): Promise<void> {
  const tree = await scanLocalDirectory(localPath)

  for (const dir of tree.directories) {
    const target = remoteChildPath(localPath, dir, remotePath)
    await sshPool.exec(`mkdir -p ${quoteShell(target)}`, { retry: true, timeout: 10_000 })
  }

  await sshPool.withSftp(async (sftp: any) => {
    for (const file of tree.files) {
      const target = remoteChildPath(localPath, file, remotePath)
      await sftpFastPut(sftp, file, target)
    }
  })
}

function remoteChildPath(localBase: string, localChild: string, remoteBase: string): string {
  const relative = path.relative(localBase, localChild)
  if (relative === "") {
    return remoteBase
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`remote_push received path outside requested directory: ${localChild}`)
  }

  const segments = relative.split(path.sep)
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error(`remote_push received unsafe local path segment: ${localChild}`)
    }
  }

  return path.posix.join(remoteBase, ...segments)
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
