import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"

export function createRemoteRemoveConfigTool(server: McpServer, connectionManager: ConnectionManager) {
  server.tool(
    "remote_remove_config",
    "Remove a remote machine configuration template. If the machine is currently connected, it will be disconnected first.",
    {
      name: z.string().describe("Name of the machine configuration to remove"),
    },
    async ({ name }) => {
      try {
        await connectionManager.removeConfig(name)

        return {
          content: [
            {
              type: "text",
              text: `Configuration "${name}" removed successfully.`,
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Failed to remove config: ${msg}` }],
          isError: true,
        }
      }
    }
  )
}
