import { z } from "zod";
export function createRemoteDisconnectTool(server, connectionManager) {
    server.registerTool("remote_disconnect", {
        description: `Disconnect from a remote machine and clean up resources.`,
        inputSchema: {
            machine: z.string().describe("Name of the remote machine to disconnect"),
        },
    }, async ({ machine }) => {
        try {
            await connectionManager.disconnect(machine);
            return {
                content: [
                    {
                        type: "text",
                        text: `Disconnected from "${machine}" successfully.`,
                    },
                ],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to disconnect: ${msg}`,
                    },
                ],
            };
        }
    });
}
//# sourceMappingURL=remote-disconnect.js.map