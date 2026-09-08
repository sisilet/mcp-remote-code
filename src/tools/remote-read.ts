import fs from "fs/promises"
import path from "path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js"

const DEFAULT_LIMIT = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".pyc", ".pyo", ".class", ".o", ".a", ".obj",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
])

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

async function checkRemoteBinary(
  sshPool: any,
  remotePath: string
): Promise<{ isBinary: boolean; reason?: string }> {
  if (isBinaryByExtension(remotePath)) {
    return { isBinary: true, reason: "binary extension" }
  }

  const fileResult = await sshPool.exec(
    `file -b ${quoteShell(remotePath)} 2>/dev/null || echo "UNKNOWN"`,
    { retry: true, timeout: 10_000 }
  )
  const fileDesc = fileResult.stdout.trim().toLowerCase()
  if (fileDesc !== "unknown" && !fileDesc.includes("text") && !fileDesc.includes("empty")) {
    return { isBinary: true, reason: `file type: ${fileResult.stdout.trim()}` }
  }

  const nullCheck = await sshPool.exec(
    `dd bs=4096 count=1 if=${quoteShell(remotePath)} 2>/dev/null | od -An -tx1 | grep -q ' 00 ' && echo HAS_NULL || echo NO_NULL`,
    { retry: true, timeout: 10_000 }
  )
  if (nullCheck.stdout.trim() === "HAS_NULL") {
    return { isBinary: true, reason: "null bytes detected" }
  }

  return { isBinary: false }
}

export function createRemoteReadTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_read",
    {
      description: `Read the contents of a file or list a directory on the remote machine within the configured root.`,
      inputSchema: {
        target: targetSchema,
        filePath: z.string().describe("The path to the file or directory to read on the remote machine (absolute or relative to root)"),
        offset: z.number().optional().describe("The line number to start reading from (1-indexed)"),
        limit: z.number().optional().describe("The maximum number of lines to read (defaults to 2000)"),
      },
    },
    async ({ target, filePath, offset: offsetArg, limit: limitArg }) => {
      const connOrError = await requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const jailed = await jailRemotePath(conn, filePath, { allowMissing: true })
      if ("errorText" in jailed) {
        return textResult(jailed.errorText)
      }
      const remotePath = jailed.path

      const localPath = conn.pathMapper.toLocal(remotePath)
      const limit = limitArg ?? DEFAULT_LIMIT
      const offset = (offsetArg ?? 1) - 1

      const typeResult = await conn.sshPool.exec(
        `if [ -d ${quoteShell(remotePath)} ]; then echo "DIR"; elif [ -f ${quoteShell(remotePath)} ]; then echo "FILE"; else echo "MISSING"; fi`,
        { retry: true, timeout: 10_000 }
      )
      const remoteType = typeResult.stdout.trim()

      if (remoteType === "DIR") {
        const result = await conn.sshPool.exec(
          `ls -1pA ${quoteShell(remotePath)}`,
          { retry: true, timeout: 15_000 }
        )
        const items = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
        items.sort((a, b) => a.localeCompare(b))
        const start = offset
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        const output = [
          `<path>${remotePath}</path>`,
          `<type>directory</type>`,
          `<entries>`,
          sliced.join("\n"),
          truncated
            ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length + 1})`
            : `\n(${items.length} entries)`,
          `</entries>`,
        ].join("\n")

        return {
          content: [{ type: "text" as const, text: output }],
        }
      }

      if (remoteType === "MISSING") {
        const remoteDir = path.posix.dirname(remotePath)
        const base = path.posix.basename(remotePath).toLowerCase()
        let suggestions: string[] = []
        try {
          const result = await conn.sshPool.exec(`ls -1A ${quoteShell(remoteDir)}`, { retry: true, timeout: 10_000 })
          const items = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
          suggestions = items
            .filter((i) => i.toLowerCase().includes(base) || base.includes(i.toLowerCase()))
            .slice(0, 3)
        } catch {}
        if (suggestions.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File not found: ${remotePath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`,
              },
            ],
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `File not found: ${remotePath}`,
            },
          ],
        }
      }

      const binaryCheck = await checkRemoteBinary(conn.sshPool, remotePath)
      if (binaryCheck.isBinary) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot read binary file: ${remotePath}\n\nReason: ${binaryCheck.reason}. Use remote_bash tools to inspect it if needed.`,
            },
          ],
        }
      }

      await conn.syncEngine.register(remotePath)
      await conn.syncEngine.pullAll()

      const buf = await fs.readFile(localPath)
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)
      const lines = content.split("\n")

      if (offset > lines.length && lines.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Offset ${offsetArg} is out of range (file has ${lines.length} lines)`,
            },
          ],
        }
      }

      const start = offset
      let bytes = 0
      const out: string[] = []
      let cut = false
      let more = false

      for (let i = start; i < lines.length; i++) {
        if (out.length >= limit) {
          more = true
          break
        }
        let line = lines[i]
        if (line.length > MAX_LINE_LENGTH) {
          line = line.substring(0, MAX_LINE_LENGTH) + " ... (line truncated)"
        }
        const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          cut = true
          more = true
          break
        }
        out.push(line)
        bytes += size
      }

      let output = [`<path>${remotePath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += out.map((line, i) => `${i + start + 1}: ${line}`).join("\n")
      const last = start + out.length
      if (cut) {
        output += `\n\n(Output capped at ${MAX_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`
      } else if (more) {
        output += `\n\n(Showing lines ${start + 1}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
      } else {
        output += `\n\n(End of file - total ${lines.length} lines)`
      }
      output += "\n</content>"

      return {
        content: [{ type: "text" as const, text: output }],
      }
    }
  )
}
