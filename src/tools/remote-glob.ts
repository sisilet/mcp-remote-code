import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"

export function createRemoteGlobTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_glob",
    {
      description: `Find files matching a glob pattern on a remote machine.`,
      inputSchema: {
        machine: z.string().optional().describe("Name of the remote machine. If omitted and only one machine is connected, uses that machine."),
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z.string().optional().describe("The directory to search in on the remote machine. Omit to use the default remote directory."),
      },
    },
    async ({ machine, pattern, path: searchDir }) => {
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

      const actualDir = searchDir || conn.config.remoteWorkdir
      const limit = 100

      // Try ripgrep with reverse-time sorting first
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'")
      const rgCmd = `cd ${quoteShell(actualDir)} && rg --files --sortr=modified --glob '${escapedPattern}' 2>/dev/null`
      let result = await conn.sshPool.exec(rgCmd, { timeout: 30_000 })

      let lines: string[]

      if (result.stdout.trim()) {
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      } else {
        // Fallback: find + stat for sorting
        const namePredicate = buildFindNamePredicate(pattern)
        const findCmd = `cd ${quoteShell(actualDir)} && find . -maxdepth 10 ${namePredicate} -type f -exec stat -c '%Y %n' {} + 2>/dev/null | sort -rn | cut -d' ' -f2-`
        result = await conn.sshPool.exec(findCmd, { timeout: 30_000 })
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      }

      // Deduplicate and limit
      const seen = new Set<string>()
      const files: string[] = []
      for (const line of lines) {
        const full = line.startsWith("/") ? line : actualDir + "/" + line.replace(/^\.\//, "")
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

      return {
        content: [
          {
            type: "text" as const,
            text: `[${conn.name}] ${actualDir}\n\n${output.join("\n")}`,
          },
        ],
      }
    }
  )
}

import { quoteShell } from "../shell-quote.js"

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
