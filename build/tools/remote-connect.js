import { z } from "zod";
export function createRemoteConnectTool(server, connectionManager) {
    server.tool("remote_connect", "Connect to a remote machine via SSH. You can connect by referencing a saved config (use remote_list_configs to see available configs) or by providing connection details directly.", {
        machine: z.string().describe("Machine name. If a config with this name exists, it will use the saved config. Otherwise, this becomes the connection name."),
        ssh: z.string().optional().describe("SSH command string (e.g., 'ssh user@host'). Required if no config exists for this machine name."),
        workdir: z.string().optional().describe("Working directory on remote. Required if no config exists for this machine name."),
        password: z.string().optional().describe("SSH password (overrides saved config if provided)"),
        sudo_password: z.string().optional().describe("Sudo password (overrides saved config if provided)"),
    }, async ({ machine, ssh, workdir, password, sudo_password }) => {
        try {
            const config = connectionManager.getConfig(machine);
            let info;
            if (config) {
                info = await connectionManager.connectFromConfig(machine);
            }
            else {
                if (!ssh || !workdir) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No config found for "${machine}". Please provide ssh and workdir parameters, or use remote_add_config to add a configuration first.`,
                            },
                        ],
                        isError: true,
                    };
                }
                info = await connectionManager.connectWithParams(machine, ssh, workdir, password, sudo_password);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Connected successfully to "${info.name}"\n  Host: ${info.user}@${info.host}:${info.port}\n  Workdir: ${info.workdir}\n  Platform: ${info.platform}\n  Git repo: ${info.isGitRepo ? "yes" : "no"}`,
                    },
                ],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: "text", text: `Failed to connect: ${msg}` }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=remote-connect.js.map