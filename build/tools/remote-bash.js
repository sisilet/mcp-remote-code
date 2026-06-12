import { z } from "zod";
export function createRemoteBashTool(server, connectionManager) {
    server.registerTool("remote_bash", {
        description: `Execute commands in a bash shell on a remote machine. Use the 'machine' parameter to specify which connected remote machine to target.`,
        inputSchema: {
            machine: z.string().optional().describe("Name of the remote machine. If omitted and only one machine is connected, uses that machine."),
            command: z.string().describe("The bash command to execute"),
            description: z.string().describe("A short description of what the command does"),
            timeout: z.number().optional().describe("Timeout in milliseconds (optional, default 120000)"),
            workdir: z.string().optional().describe("Working directory on the remote machine (optional)"),
        },
    }, async ({ machine, command, description, timeout, workdir }) => {
        const conn = connectionManager.get(machine);
        if (!conn) {
            return {
                content: [
                    {
                        type: "text",
                        text: machine
                            ? `Connection "${machine}" not found. Use remote_list_machines to see available connections.`
                            : "No remote machines connected. Use remote_connect to connect, or specify a machine name.",
                    },
                ],
            };
        }
        const actualTimeout = timeout ?? 120_000;
        if (actualTimeout < 0) {
            return {
                content: [{ type: "text", text: "Error: Timeout must be a non-negative number" }],
            };
        }
        const result = await conn.sshPool.exec(command, {
            cwd: workdir ?? conn.config.remoteWorkdir,
            timeout: actualTimeout,
        });
        let stdout = result.stdout || "";
        let stderr = result.stderr || "";
        stderr = filterSshNoise(stderr);
        const stderrErrors = [
            "command not found",
            "no such file or directory",
            "permission denied",
            "sorry, you must have a tty to run sudo",
        ];
        const hasStderrError = stderrErrors.some((e) => stderr.toLowerCase().includes(e));
        if (result.exitCode !== 0 || hasStderrError) {
            const parts = [];
            if (stdout.trim())
                parts.push(stdout);
            if (stderr.trim())
                parts.push(`stderr:\n${stderr}`);
            const message = parts.length > 0 ? parts.join("\n\n") : "(no output)";
            return {
                content: [
                    {
                        type: "text",
                        text: `[${conn.name}] Command failed with exit code ${result.exitCode}:\n${command}\n\n${message}`,
                    },
                ],
            };
        }
        let output = stdout;
        if (stderr.trim()) {
            output += "\n\nstderr:\n" + stderr;
        }
        if (!output.trim()) {
            output = "(no output)";
        }
        return {
            content: [
                {
                    type: "text",
                    text: `[${conn.name}] ${description || "bash"}\n\n${output}`,
                },
            ],
        };
    });
}
const SSH_NOISE_PATTERNS = [
    /^Warning: Permanently added .* to the list of known hosts\.\s*$/,
    /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\s*$/,
    /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\s*$/,
    /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\s*$/,
    /^Connection to .* closed\.\s*$/,
];
function filterSshNoise(stderr) {
    return stderr
        .split("\n")
        .filter((line) => !SSH_NOISE_PATTERNS.some((p) => p.test(line)))
        .join("\n");
}
//# sourceMappingURL=remote-bash.js.map