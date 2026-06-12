import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"

export function createRemoteDisconnectTool(
  server: McpServer,
  connectionManager: ConnectionManager
) {
  server.registerTool(
    "remote_disconnect",
    {
      description: `Disconnect from a remote machine and clean up resources.`,
      inputSchema: {
        machine: z.string().describe("Name of the remote machine to disconnect"),
      },
    },
    async ({ machine }) => {
      try {
        await connectionManager.disconnect(machine)
        return {
          content: [
            {
              type: "text" as const,
              text: `Disconnected from "${machine}" successfully.`,
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to disconnect: ${msg}`,
            },
          ],
        }
      }
    }
  )
}
