import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"
import { quoteShell } from "../shell-quote.js"
import { jailRemotePath, requireConnection, targetSchema, textResult } from "../tool-utils.js"

export function createRemoteHashTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_hash",
    {
      description: `Compute the SHA-256 hash of a remote file within the configured root. Compare hashes across targets or against a local file to verify content quickly.`,
      inputSchema: {
        target: targetSchema,
        path: z.string().describe("The remote file path (absolute or relative to root)."),
      },
    },
    async ({ target, path: inputPath }) => {
      const connOrError = await requireConnection(connectionManager, target)
      if ("errorText" in connOrError) {
        return textResult(connOrError.errorText)
      }
      const conn = connOrError

      const jailed = await jailRemotePath(conn, inputPath)
      if ("errorText" in jailed) {
        return textResult(jailed.errorText)
      }
      const remotePath = jailed.path
      const quoted = quoteShell(remotePath)

      const typeResult = await conn.sshPool.exec(
        `if [ -f ${quoted} ]; then echo FILE; elif [ -d ${quoted} ]; then echo DIR; else echo MISSING; fi`,
        { retry: true, timeout: 10_000 }
      )
      const remoteType = typeResult.stdout.trim()
      if (remoteType === "MISSING") {
        return textResult(`File not found: ${remotePath}`)
      }
      if (remoteType === "DIR") {
        return textResult(`remote_hash only supports files, not directories: ${remotePath}`)
      }

      const hashResult = await conn.sshPool.exec(
        `sha256sum ${quoted} 2>/dev/null | awk '{print $1}' || openssl dgst -sha256 ${quoted} | awk '{print $NF}'`,
        { retry: true, timeout: 120_000 }
      )
      const hash = hashResult.stdout.trim().split("\n").find(Boolean)
      if (!hash) {
        return textResult(`remote_hash failed for ${remotePath}: ${hashResult.stderr || "no output"}`)
      }

      return textResult(
        [
          `Target: ${conn.name}`,
          `Path: ${remotePath}`,
          `Algorithm: sha256`,
          `Hash: ${hash}`,
        ].join("\n")
      )
    }
  )
}
