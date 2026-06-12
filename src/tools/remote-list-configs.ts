import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ConnectionManager } from "../connection-manager.js"

export function createRemoteListConfigsTool(server: McpServer, connectionManager: ConnectionManager) {
  server.tool(
    "remote_list_configs",
    "List all configured remote machines (not necessarily connected). Shows connection status for each.",
    {},
    async () => {
      const configs = connectionManager.listConfigs()

      if (configs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No machine configs found. Use remote_add_config to add one.",
            },
          ],
        }
      }

      const lines = configs.map((config) => {
        const status = config.connected ? "connected" : "disconnected"
        const desc = config.description ? ` - ${config.description}` : ""
        return `- ${config.name}${desc}\n  Status: ${status}\n  SSH: ${config.sshCommand}\n  Workdir: ${config.workdir}`
      })

      return {
        content: [
          {
            type: "text",
            text: `Configured Remote Machines (${configs.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      }
    }
  )
}
