import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"
import { jailRemoteDir, requireConnection, targetSchema, textResult } from "../tool-utils.js"

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
      description: `Search file contents using grep/ripgrep on the remote machine within the configured root.`,
      inputSchema: {
        target: targetSchema,
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z.string().optional().describe("The directory to search in on the remote machine. Defaults to the configured root."),
        include: z.string().optional().describe("File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}')"),
      },
    },
    async ({ target, pattern, path: searchDir, include }) => {
      const connOrError = requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const dirResult = jailRemoteDir(conn, searchDir)
      if ("errorText" in dirResult) {
        return textResult(dirResult.errorText)
      }
      const actualDir = dirResult.path
      const limit = 100

      let cmd: string
      const escapedPattern = pattern.replace(/'/g, "'\"'\"'")
      if (include) {
        const glob = include.replace(/'/g, "'\"'\"'")
        cmd = `cd ${quoteShell(actualDir)} && rg --json --sortr=modified --glob '${glob}' -n -- '${escapedPattern}' 2>/dev/null`
      } else {
        cmd = `cd ${quoteShell(actualDir)} && rg --json --sortr=modified -n -- '${escapedPattern}' 2>/dev/null`
      }

      let result = await conn.sshPool.exec(cmd, { timeout: 30_000 })

      if (!result.stdout.trim()) {
        if (include) {
          const glob = include.replace(/'/g, "'\"'\"'")
          cmd = `cd ${quoteShell(actualDir)} && grep -Ern --include='${glob}' -- '${escapedPattern}' . 2>/dev/null`
        } else {
          cmd = `cd ${quoteShell(actualDir)} && grep -Ern -- '${escapedPattern}' . 2>/dev/null`
        }
        result = await conn.sshPool.exec(cmd, { timeout: 30_000 })
        return parseGrepOutput(result.stdout, actualDir, pattern, limit)
      }

      return parseRgJsonOutput(result.stdout, actualDir, pattern, limit)
    }
  )
}

function parseRgJsonOutput(stdout: string, searchDir: string, pattern: string, limit: number) {
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

  return formatGrepResult(matches, pattern, limit)
}

function parseGrepOutput(stdout: string, searchDir: string, pattern: string, limit: number) {
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

  return formatGrepResult(matches, pattern, limit)
}

function formatGrepResult(
  matches: Array<{ path: string; line: number; text: string }>,
  pattern: string,
  limit: number
) {
  if (matches.length === 0) {
    return textResult(`Pattern: ${pattern}\n\nNo files found on remote`)
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

  return textResult(`${pattern}\n\n${output.join("\n")}`)
}
