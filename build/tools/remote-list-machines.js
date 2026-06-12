export function createRemoteListMachinesTool(server, connectionManager) {
    server.registerTool("remote_list_machines", {
        description: `List all currently connected remote machines and their status.`,
        inputSchema: {},
    }, async () => {
        const machines = connectionManager.list();
        if (machines.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No remote machines connected. Use remote_connect to connect.",
                    },
                ],
            };
        }
        const lines = machines.map((m) => `  ${m.name}: ${m.user}@${m.host}:${m.port} | ${m.platform} | ${m.workdir} | git:${m.isGitRepo ? "yes" : "no"}`);
        return {
            content: [
                {
                    type: "text",
                    text: `Connected machines (${machines.length}):\n${lines.join("\n")}`,
                },
            ],
        };
    });
}
//# sourceMappingURL=remote-list-machines.js.map