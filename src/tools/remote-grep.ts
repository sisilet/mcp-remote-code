import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"

interface RgMatch {
  type: "match"
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
    absolute_offset: number
    submatches: Array<{
      match: { text: string }
      start: number
      end: number
    }>
  }
}

interface RgSummary {
  type: "summary"
  data: {
    stats: {
      matches: number
    }
  }
}

type RgMessage = RgMatch | RgSummary | { type: string }

export function createRemoteGrepTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_grep",
    {
      description: `Search file contents using grep/ripgrep on a remote machine.`,
      inputSchema: {
        machine: z.string().optional().describe("Name of the remote machine. If omitted and only one machine is connected, uses that machine."),
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z.string().optional().describe("The directory to search in on the remote machine. Defaults to the remote working directory."),
        include: z.string().optional().describe("File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}')"),
      },
    },
    async ({ machine, pattern, path: searchDir, include }) => {
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

      // Try ripgrep with JSON output and reverse-time sorting first
      let cmd: string
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'")
      if (include) {
        const glob = include.replace(/'/g, "'\"'\"'")
        cmd = `cd ${quoteShell(actualDir)} && rg --json --sortr=modified --glob '${glob}' -n -- '${escapedPattern}' 2>/dev/null`
      } else {
        cmd = `cd ${quoteShell(actualDir)} && rg --json --sortr=modified -n -- '${escapedPattern}' 2>/dev/null`
      }

      let result = await conn.sshPool.exec(cmd, { timeout: 30_000 })

      // Fallback to grep if rg not available or produced no output
      if (!result.stdout.trim()) {
        if (include) {
          const glob = include.replace(/'/g, "'\"'\"'")
          cmd = `cd ${quoteShell(actualDir)} && grep -Ern --include='${glob}' -- '${escapedPattern}' . 2>/dev/null`
        } else {
          cmd = `cd ${quoteShell(actualDir)} && grep -Ern -- '${escapedPattern}' . 2>/dev/null`
        }
        result = await conn.sshPool.exec(cmd, { timeout: 30_000 })
        return parseGrepOutput(result.stdout, actualDir, pattern, limit, conn.name)
      }

      return parseRgJsonOutput(result.stdout, actualDir, pattern, limit, conn.name)
    }
  )
}

function parseRgJsonOutput(stdout: string, searchDir: string, pattern: string, limit: number, machine: string) {
  const lines = stdout.split("\n").filter(Boolean)
  const matches: Array<{ path: string; line: number; text: string }> = []

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as RgMessage
      if (msg.type === "match") {
        const m = msg as RgMatch
        const rawPath = m.data.path.text
        const fullPath = rawPath.startsWith("/") ? rawPath : searchDir + "/" + rawPath
        matches.push({
          path: fullPath,
          line: m.data.line_number,
          text: m.data.lines.text,
        })
      }
    } catch {
      // ignore malformed JSON lines
    }
  }

  return formatGrepResult(matches, pattern, limit, machine)
}

function parseGrepOutput(stdout: string, searchDir: string, pattern: string, limit: number, machine: string) {
  const lines = stdout.split("\n").filter(Boolean)
  const matches: Array<{ path: string; line: number; text: string }> = []

  for (const line of lines) {
    const firstColon = line.indexOf(":")
    if (firstColon === -1) continue
    const secondColon = line.indexOf(":", firstColon + 1)
    if (secondColon === -1) continue

    let rawPath = line.slice(0, firstColon)
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10)
    const text = line.slice(secondColon + 1)

    if (isNaN(lineNum)) continue
    if (rawPath.startsWith("./")) rawPath = rawPath.slice(2)
    const fullPath = rawPath.startsWith("/") ? rawPath : searchDir + "/" + rawPath

    matches.push({ path: fullPath, line: lineNum, text })
  }

  return formatGrepResult(matches, pattern, limit, machine)
}

function formatGrepResult(
  matches: Array<{ path: string; line: number; text: string }>,
  pattern: string,
  limit: number,
  machine: string
) {
  if (matches.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[${machine}] Pattern: ${pattern}\n\nNo files found on remote`,
        },
      ],
    }
  }

  const total = matches.length
  const truncated = total > limit
  const display = truncated ? matches.slice(0, limit) : matches

  const output: string[] = []
  output.push(`Found ${total} matches${truncated ? ` (showing first ${limit})` : ""}`)

  let current = ""
  for (const m of display) {
    if (current !== m.path) {
      if (current !== "") output.push("")
      current = m.path
      output.push(`${m.path}:`)
    }
    const text = m.text.length > 2000 ? m.text.substring(0, 2000) + "..." : m.text
    output.push(`  Line ${m.line}: ${text}`)
  }

  if (truncated) {
    output.push("")
    output.push(
      `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific pattern.)`
    )
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `[${machine}] ${pattern}\n\n${output.join("\n")}`,
      },
    ],
  }
}

import { quoteShell } from "../shell-quote.js"
