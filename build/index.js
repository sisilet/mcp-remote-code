#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { ConnectionManager } from "./connection-manager.js";
import { resolveStartupConnections } from "./config.js";
import { initElicitation } from "./elicitation.js";
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
/**
 * Read from package.json rather than restated here, where it went stale by
 * four releases and was served in the MCP initialize payload (review F-41).
 */
const VERSION = (() => {
    try {
        const pkgPath = new URL("../package.json", import.meta.url);
        return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
})();
const LOG_FILE = path.join(os.homedir(), ".mcp-remote-code.log");
const HELP_TEXT = `
MCP Remote Code Server v${VERSION}

Usage: mcp-remote-code [options]

Options:
  --config <path>       JSON targets file (recommended)
  --ssh <user@host>     SSH target (legacy; repeat for multiple targets)
  --key <path>          Identity file for the preceding --ssh
  --path <dir>          Remote root directory for the preceding --ssh
  --remote <spec>       Alias for --ssh (also accepts user@host:/path shorthand)
  --root <path>         Alias for --path
  --name <name>         Target name for the preceding --ssh
  --workdir <path>      Alias for --path
  --password <pwd>      SSH password for the preceding --ssh
  --sudo-password <pwd> Sudo password for the preceding --ssh
  -v, --version         Show version
  -h, --help            Show this help message

Default config file:
  ~/.mcp-remote-code/targets.json

Recommended for Cursor / Claude Desktop:
  --config ~/.mcp-remote-code/targets.json

Legacy CLI example (two targets):
  mcp-remote-code \\
    --ssh user@host-a --key ~/.ssh/key --path /repo-a --name alpha \\
    --ssh user@host-b --key ~/.ssh/key --path /repo-b --name beta
`;
async function logDebug(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await fs.appendFile(LOG_FILE, line).catch(() => { });
}
function processCommand(pid) {
    try {
        if (process.platform === "linux") {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
            if (cmdline)
                return cmdline;
        }
    }
    catch {
        // fall through to ps
    }
    try {
        return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: 1_000,
        }).trim();
    }
    catch {
        try {
            return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
                encoding: "utf8",
                timeout: 1_000,
            }).trim();
        }
        catch {
            return "(unknown)";
        }
    }
}
function describeLauncher() {
    const pid = process.pid;
    const ppid = process.ppid;
    const parentCmd = processCommand(ppid);
    const hints = [
        process.env.CURSOR_TRACE_ID ? "cursor" : null,
        process.env.VSCODE_PID ? "vscode/cursor" : null,
        process.env.CLAUDE_CODE_ENTRYPOINT ? "claude-code" : null,
        /Claude/i.test(parentCmd) ? "claude-desktop" : null,
        /Cursor/i.test(parentCmd) ? "cursor" : null,
    ].filter(Boolean);
    return [
        `pid=${pid}`,
        `ppid=${ppid}`,
        `parent=${parentCmd}`,
        hints.length > 0 ? `agent_hint=${hints.join(",")}` : null,
    ]
        .filter(Boolean)
        .join(" ");
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
    await logDebug(`MCP Remote Code Server starting (${describeLauncher()})`);
    const startups = await resolveStartupConnections(argv);
    const connectionManager = new ConnectionManager();
    const { connected, failed } = await connectionManager.connectAll(startups);
    for (const info of connected) {
        if (info.transport === "local") {
            console.error(`[INFO] Connected target "${info.name}": local root=${info.workdir}`);
            await logDebug(`Connected: target=${info.name}, transport=local, root=${info.workdir}`);
        }
        else {
            console.error(`[INFO] Connected target "${info.name}": ${info.user}@${info.host}:${info.port} root=${info.workdir}`);
            await logDebug(`Connected: target=${info.name}, host=${info.host}, root=${info.workdir}`);
        }
    }
    for (const entry of failed) {
        console.error(`[WARN] Offline target "${entry.name}": ${entry.error}`);
        await logDebug(`Offline: target=${entry.name}, error=${entry.error}`);
    }
    const server = new McpServer({
        name: "mcp-remote-code",
        version: VERSION,
    }, {
        instructions: buildServerInstructions(connected, failed),
    });
    // Elicitation: real user prompts for outside-root commands (D-B).
    // Disable globally with MCP_ELICITATION=off, or per target in targets.json.
    initElicitation(server, process.env.MCP_ELICITATION === "off" ? "off" : "on");
    registerTools(server, connectionManager);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[READY] MCP Remote Code Server running on stdio");
    await logDebug(`READY (${describeLauncher()})`);
    let shuttingDown = false;
    const shutdown = async (code = 0) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.error("[SHUTDOWN] Closing connections...");
        await connectionManager.close().catch(() => { });
        process.exit(code);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // An emitter error with no listener, or a rejected promise nobody awaited,
    // otherwise takes the whole stdio server down with an unhelpful stack and
    // no chance to close the SSH transports (review F-43). Log to stderr —
    // stdout is the JSON-RPC channel — and shut down deliberately.
    process.on("unhandledRejection", (reason) => {
        console.error("[FATAL] Unhandled promise rejection:", reason);
        void logDebug(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
            .finally(() => shutdown(1));
    });
    process.on("uncaughtException", (error) => {
        console.error("[FATAL] Uncaught exception:", error);
        void logDebug(`Uncaught exception: ${error.message}`).finally(() => shutdown(1));
    });
}
main().catch(async (error) => {
    console.error("Fatal error in main():", error);
    await logDebug(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map