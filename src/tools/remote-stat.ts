import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js"

export function createRemoteStatTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_stat",
    {
      description: `Get metadata for a remote file or directory within the configured root.`,
      inputSchema: {
        target: targetSchema,
        path: z.string().describe("The remote file or directory path (absolute or relative to root)."),
      },
    },
    async ({ target, path: inputPath }) => {
      const connOrError = await requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const jailed = await jailRemotePath(conn, inputPath, { allowMissing: true })
      if ("errorText" in jailed) {
        return textResult(jailed.errorText)
      }
      const remotePath = jailed.path
      const quoted = quoteShell(remotePath)

      // stat -c does not interpret backslash escapes, so a literal \t in the
      // format string is emitted verbatim and the result never splits into
      // fields (review F-23). Emit space-separated values from stat, then
      // re-join with real tabs via printf, which does interpret \t.
      const command = `
if [ -L ${quoted} ]; then
  printf 'symlink\\t%s\\n' "$(readlink ${quoted})"
elif [ -f ${quoted} ]; then
  printf 'file\\t%s\\t%s\\t%s\\t%s\\n' $(stat -c '%s %Y %W %a' ${quoted})
elif [ -d ${quoted} ]; then
  printf 'directory\\t%s\\t%s\\t%s\\t%s\\n' $(stat -c '%s %Y %W %a' ${quoted})
else
  printf 'missing\\t0\\t0\\t0\\t0\\n'
fi
`
      const result = await conn.sshPool.exec(command, { retry: true, timeout: 15_000 })
      const line = result.stdout.trim().split("\n").find(Boolean)
      if (!line) {
        return textResult(`remote_stat failed for ${remotePath}: ${result.stderr || "no output"}`)
      }

      const fields = line.split("\t")
      const type = fields[0]
      if (type === "missing") {
        return textResult(`Path not found: ${remotePath}`)
      }

      const output = [
        `Target: ${conn.name}`,
        `Path: ${remotePath}`,
        `Type: ${type}`,
      ]

      if (type === "symlink") {
        output.push(`Link target: ${fields[1] || ""}`)
      } else {
        output.push(
          `Size: ${fields[1] || "0"} bytes`,
          `Modified (epoch): ${fields[2] || "0"}`,
          `Birth (epoch): ${fields[3] || "0"}`,
          `Mode (octal): ${fields[4] || "0"}`
        )
      }

      return textResult(output.join("\n"))
    }
  )
}
