import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ConnectionManager } from "../connection-manager.js"

export function createRemoteAddConfigTool(server: McpServer, connectionManager: ConnectionManager) {
  server.tool(
    "remote_add_config",
    "Add a new remote machine configuration template. This only saves the config, it does not connect.",
    {
      name: z.string().describe("Unique name for this machine configuration"),
      ssh: z.string().describe("SSH command string (e.g., 'ssh -oHostKeyAlgorithms=+ssh-rsa user@host')"),
      workdir: z.string().describe("Working directory on the remote machine"),
      password: z.string().optional().describe("SSH password (optional, can be provided later)"),
      sudo_password: z.string().optional().describe("Sudo password (optional)"),
      description: z.string().optional().describe("Optional description of this machine"),
    },
    async ({ name, ssh, workdir, password, sudo_password, description }) => {
      try {
        await connectionManager.addConfig({
          name,
          sshCommand: ssh,
          workdir,
          password,
          sudoPassword: sudo_password,
          description,
        })

        return {
          content: [
            {
              type: "text",
              text: `Configuration "${name}" added successfully.\n\nUse remote_connect with machine="${name}" to connect.`,
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Failed to add config: ${msg}` }],
          isError: true,
        }
      }
    }
  )
}
