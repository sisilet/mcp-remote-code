#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { ConnectionManager } from "./connection-manager.js";
import { resolveStartupConnections } from "./config.js";
import { createRemoteBashTool } from "./tools/remote-bash.js";
import { createRemoteGlobTool } from "./tools/remote-glob.js";
import { createRemoteGrepTool } from "./tools/remote-grep.js";
import { createRemoteReadTool } from "./tools/remote-read.js";
import { createRemoteWriteTool } from "./tools/remote-write.js";
import { createRemoteEditTool } from "./tools/remote-edit.js";
import { createRemotePatchTool } from "./tools/remote-patch.js";
import { createRemotePullTool } from "./tools/remote-pull.js";
import { createRemotePushTool } from "./tools/remote-push.js";
import { createRemoteStatTool } from "./tools/remote-stat.js";
import { createRemoteHashTool } from "./tools/remote-hash.js";
import { buildServerInstructions } from "./server-instructions.js";
const VERSION = "2.1.0";
const HELP_TEXT = `
MCP Remote Code Server v${VERSION}

Usage: mcp-remote-code [options]

Options:
  --ssh <user@host>     SSH target (repeat for multiple targets)
  --key <path>          Identity file for the preceding --ssh
  --path <dir>          Remote root directory for the preceding --ssh
  --remote <spec>       Alias for --ssh (also accepts user@host:/path shorthand)
  --root <path>         Alias for --path
  --name <name>         Target name for the preceding --ssh
  --config <path>       JSON file with a targets array
  --workdir <path>      Alias for --path
  --password <pwd>      SSH password for the preceding --ssh
  --sudo-password <pwd> Sudo password for the preceding --ssh
  -v, --version         Show version
  -h, --help            Show this help message

Default config file (fallback only):
  ~/.opencode/mcp-remote-code-targets.json

Recommended for Cursor / Claude Desktop — pass targets in mcp.json args:
  --ssh user@host --key ~/.ssh/id_rsa --path /repo --name alpha

Example (two targets):
  mcp-remote-code \\
    --ssh user@host-a --key ~/.ssh/key --path /repo-a --name alpha \\
    --ssh user@host-b --key ~/.ssh/key --path /repo-b --name beta
`;
async function logDebug(msg) {
    const logFile = path.join(os.homedir(), ".opencode", "mcp-remote-code-debug.log");
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await fs.appendFile(logFile, line).catch(() => { });
}
function handleHelpAndVersion(argv) {
    for (const arg of argv) {
        if (arg === "-h" || arg === "--help") {
            console.log(HELP_TEXT);
            process.exit(0);
        }
        if (arg === "-v" || arg === "--version") {
            console.log(VERSION);
            process.exit(0);
        }
    }
    return false;
}
function registerTools(server, connectionManager) {
    createRemoteBashTool(server, connectionManager);
    createRemoteGlobTool(server, connectionManager);
    createRemoteGrepTool(server, connectionManager);
    createRemoteReadTool(server, connectionManager);
    createRemoteWriteTool(server, connectionManager);
    createRemoteEditTool(server, connectionManager);
    createRemotePatchTool(server, connectionManager);
    createRemotePullTool(server, connectionManager);
    createRemotePushTool(server, connectionManager);
    createRemoteStatTool(server, connectionManager);
    createRemoteHashTool(server, connectionManager);
}
async function main() {
    const argv = process.argv.slice(2);
    handleHelpAndVersion(argv);
    await logDebug("MCP Remote Code Server starting...");
    const startups = await resolveStartupConnections(argv);
    const connectionManager = new ConnectionManager();
    const infos = await connectionManager.connectAll(startups);
    for (const info of infos) {
        console.error(`[INFO] Connected target "${info.name}": ${info.user}@${info.host}:${info.port} root=${info.workdir}`);
        await logDebug(`Connected: target=${info.name}, host=${info.host}, root=${info.workdir}`);
    }
    const server = new McpServer({
        name: "mcp-remote-code",
        version: VERSION,
    }, {
        instructions: buildServerInstructions(infos),
    });
    registerTools(server, connectionManager);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[READY] MCP Remote Code Server running on stdio");
    const shutdown = async () => {
        console.error("[SHUTDOWN] Closing connections...");
        await connectionManager.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch(async (error) => {
    console.error("Fatal error in main():", error);
    await logDebug(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map