import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"
import { jailRemoteDir, keepUnderRoot, requireConnection, targetSchema, textResult } from "../tool-utils.js"

export function createRemoteGlobTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_glob",
    {
      description: `Find files matching a glob pattern on the remote machine within the configured root.`,
      inputSchema: {
        target: targetSchema,
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z.string().optional().describe("The directory to search in on the remote machine. Omit to use the configured root."),
      },
    },
    async ({ target, pattern, path: searchDir }) => {
      const connOrError = await requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const dirResult = await jailRemoteDir(conn, searchDir)
      if ("errorText" in dirResult) {
        return textResult(dirResult.errorText)
      }
      const actualDir = dirResult.path
      const limit = 100

      const escapedPattern = pattern.replace(/'/g, "'\"'\"'")
      const rgCmd = `cd ${quoteShell(actualDir)} && rg --files --sortr=modified --glob '${escapedPattern}' 2>/dev/null`
      let result = await conn.sshPool.exec(rgCmd, { retry: true, timeout: 30_000 })

      let lines: string[]

      if (result.stdout.trim()) {
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      } else {
        const namePredicate = buildFindNamePredicate(pattern)
        const findCmd = `cd ${quoteShell(actualDir)} && find . -maxdepth 10 ${namePredicate} -type f -exec stat -c '%Y %n' {} + 2>/dev/null | sort -rn | cut -d' ' -f2-`
        result = await conn.sshPool.exec(findCmd, { retry: true, timeout: 30_000 })
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      }

      const seen = new Set<string>()
      const files: string[] = []
      for (const line of lines) {
        const full = line.startsWith("/") ? line : actualDir + "/" + line.replace(/^\.\//, "")
        // A search rooted inside the jail can still return paths outside it.
        if (keepUnderRoot(conn, [full]).length === 0) continue
        if (seen.has(full)) continue
        seen.add(full)
        files.push(full)
        if (files.length >= limit + 1) break
      }

      const truncated = files.length > limit
      if (truncated) files.length = limit

      const output: string[] = []
      if (files.length === 0) output.push("No files found on remote")
      else {
        output.push(...files)
        if (truncated) {
          output.push(``)
          output.push(`(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`)
        }
      }

      return textResult(`${actualDir}\n\n${output.join("\n")}`)
    }
  )
}

function buildFindNamePredicate(pattern: string): string {
  const normalized = pattern.startsWith("**/") ? pattern.slice(3) : pattern

  const braceMatch = normalized.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!braceMatch) {
    return `-name ${quoteShell(normalized)}`
  }
  const prefix = braceMatch[1]
  const options = braceMatch[2]
  const suffix = braceMatch[3]
  const parts = options.split(",").map((opt) => `-name ${quoteShell(prefix + opt + suffix)}`)
  return `\\( ${parts.join(" -o ")} \\)`
}
