#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import express from "express";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { ConnectionManager } from "./connection-manager.js";
import { parseStartupConnections } from "./config.js";
import { createRemoteConnectTool } from "./tools/remote-connect.js";
import { createRemoteDisconnectTool } from "./tools/remote-disconnect.js";
import { createRemoteListMachinesTool } from "./tools/remote-list-machines.js";
import { createRemoteListConfigsTool } from "./tools/remote-list-configs.js";
import { createRemoteAddConfigTool } from "./tools/remote-add-config.js";
import { createRemoteRemoveConfigTool } from "./tools/remote-remove-config.js";
import { createRemoteBashTool } from "./tools/remote-bash.js";
import { createRemoteGlobTool } from "./tools/remote-glob.js";
import { createRemoteGrepTool } from "./tools/remote-grep.js";
import { createRemoteReadTool } from "./tools/remote-read.js";
import { createRemoteWriteTool } from "./tools/remote-write.js";
import { createRemoteEditTool } from "./tools/remote-edit.js";
import { createRemotePatchTool } from "./tools/remote-patch.js";
import { createRemotePullTool } from "./tools/remote-pull.js";
import { createRemotePushTool } from "./tools/remote-push.js";
const VERSION = "1.2.0";
const HELP_TEXT = `
MCP Remote Code Server v${VERSION}

Usage: mcp-remote-code [options]

Options:
  --port <port>         Server port (default: 3000)
  --host <host>         Server host (default: 127.0.0.1)
  --remote <ssh>        SSH command to connect at startup
  --workdir <path>      Remote working directory for --remote
  --name <name>         Startup connection name (default: default)
  --password <pwd>      SSH password for startup connection
  --sudo-password <pwd> Sudo password for startup connection
  -v, --version         Show version
  -h, --help            Show this help message

Machine Configuration:
  Configs are stored in ~/.opencode/mcp-remote-code-configs.json
  Use remote_add_config, remote_list_configs, remote_remove_config to manage.
  Use remote_connect to connect to a configured machine on demand.

Examples:
  # Start server
  mcp-remote-code

  # Custom port
  mcp-remote-code --port 8080 --host 0.0.0.0

  # Connect one remote machine immediately
  mcp-remote-code --remote "ssh user@host" --workdir /home/project --name dev

Workflow:
  1. Add machine configs (one-time setup)
     remote_add_config(name="prod", ssh="ssh user@host", workdir="/home/project")

  2. List available machines
     remote_list_configs

  3. Connect when needed
     remote_connect(machine="prod")

  4. Use remote tools (bash, read, write, etc.)

  5. Disconnect when done
     remote_disconnect(machine="prod")
`;
async function logDebug(msg) {
    const logFile = path.join(os.homedir(), ".opencode", "mcp-remote-code-debug.log");
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await fs.appendFile(logFile, line).catch(() => { });
}
function parseArgs() {
    const args = process.argv.slice(2);
    let port = 3000;
    let host = "127.0.0.1";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port") {
            port = parseInt(args[++i], 10);
        }
        else if (args[i] === "--host") {
            host = args[++i];
        }
        else if (args[i] === "-h" || args[i] === "--help") {
            console.log(HELP_TEXT);
            process.exit(0);
        }
        else if (args[i] === "-v" || args[i] === "--version") {
            console.log(VERSION);
            process.exit(0);
        }
    }
    return { port, host };
}
async function main() {
    await logDebug("MCP Remote Code Server starting...");
    const { port, host } = parseArgs();
    const connectionManager = new ConnectionManager();
    await connectionManager.ready();
    const startupConnections = parseStartupConnections();
    for (const startup of startupConnections) {
        if (!startup.workdir) {
            throw new Error(`Startup connection "${startup.name}" is missing a workdir. Provide --workdir or REMOTE_WORKDIR.`);
        }
        const info = await connectionManager.connectWithParams(startup.name, startup.sshCommand, startup.workdir, startup.password, startup.sudoPassword);
        console.error(`[INFO] Startup connection "${info.name}" ready: ${info.user}@${info.host}:${info.port} ${info.workdir}`);
        await logDebug(`Startup connection ready: name=${info.name}, host=${info.host}, workdir=${info.workdir}`);
    }
    const configs = connectionManager.listConfigs();
    if (configs.length > 0) {
        console.error(`[INFO] Loaded ${configs.length} machine config(s)`);
        await logDebug(`Loaded ${configs.length} machine config(s)`);
    }
    else {
        console.error("[INFO] No machine configs found. Use remote_add_config to add machines.");
        await logDebug("No machine configs");
    }
    // Setup MCP HTTP server
    const app = express();
    app.use(express.json());
    const transports = new Map();
    function createServerForSession() {
        const server = new McpServer({
            name: "mcp-remote-code",
            version: VERSION,
        });
        // Register config management tools
        createRemoteListConfigsTool(server, connectionManager);
        createRemoteAddConfigTool(server, connectionManager);
        createRemoteRemoveConfigTool(server, connectionManager);
        // Register connection management tools
        createRemoteConnectTool(server, connectionManager);
        createRemoteDisconnectTool(server, connectionManager);
        createRemoteListMachinesTool(server, connectionManager);
        // Register remote operation tools
        createRemoteBashTool(server, connectionManager);
        createRemoteGlobTool(server, connectionManager);
        createRemoteGrepTool(server, connectionManager);
        createRemoteReadTool(server, connectionManager);
        createRemoteWriteTool(server, connectionManager);
        createRemoteEditTool(server, connectionManager);
        createRemotePatchTool(server, connectionManager);
        createRemotePullTool(server, connectionManager);
        createRemotePushTool(server, connectionManager);
        return server;
    }
    function getHeaderValue(req, headerName) {
        const value = req.headers[headerName.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
    }
    function sendJsonRpcError(res, status, code, message) {
        res.status(status).json({
            jsonrpc: "2.0",
            error: { code, message },
            id: null,
        });
    }
    async function handleStreamableHttpRequest(req, res) {
        const sessionId = getHeaderValue(req, "mcp-session-id");
        let transport;
        const existingTransport = sessionId ? transports.get(sessionId) : undefined;
        if (sessionId && existingTransport) {
            if (!(existingTransport instanceof StreamableHTTPServerTransport)) {
                sendJsonRpcError(res, 400, -32000, "Bad Request: Session exists but uses a different transport protocol");
                return;
            }
            transport = existingTransport;
        }
        else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: async (initializedSessionId) => {
                    if (!transport)
                        return;
                    transports.set(initializedSessionId, transport);
                    console.error(`[CLIENT] Connected via Streamable HTTP (session: ${initializedSessionId})`);
                    await logDebug(`Streamable HTTP client connected: session=${initializedSessionId}`);
                },
                onsessionclosed: async (closedSessionId) => {
                    transports.delete(closedSessionId);
                    console.error(`[CLIENT] Streamable HTTP session closed (session: ${closedSessionId})`);
                    await logDebug(`Streamable HTTP session closed: session=${closedSessionId}`);
                },
            });
            transport.onclose = () => {
                const closedSessionId = transport?.sessionId;
                if (closedSessionId) {
                    transports.delete(closedSessionId);
                    console.error(`[CLIENT] Disconnected via Streamable HTTP (session: ${closedSessionId})`);
                    logDebug(`Streamable HTTP client disconnected: session=${closedSessionId}`).catch(() => { });
                }
            };
            const server = createServerForSession();
            await server.connect(transport);
        }
        else {
            sendJsonRpcError(res, 400, -32000, "Bad Request: No valid MCP session ID or initialize request provided");
            return;
        }
        try {
            await transport.handleRequest(req, res, req.body);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ERROR] Failed to handle Streamable HTTP request: ${msg}`);
            await logDebug(`Streamable HTTP error: error=${msg}`);
            if (!res.headersSent) {
                sendJsonRpcError(res, 500, -32603, msg);
            }
        }
    }
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            version: VERSION,
            connections: connectionManager.list().length,
            machines: connectionManager.list().map((m) => m.name),
            configs: connectionManager.listConfigs().map((c) => c.name),
            clients: transports.size,
        });
    });
    // Streamable HTTP endpoint for current MCP clients.
    app.all("/mcp", handleStreamableHttpRequest);
    // /sse is kept as the advertised endpoint, but now also accepts Streamable
    // HTTP POST/GET/DELETE requests from clients that use the newer transport.
    app.post("/sse", handleStreamableHttpRequest);
    app.delete("/sse", handleStreamableHttpRequest);
    // Deprecated HTTP+SSE endpoint for older MCP clients.
    app.get("/sse", async (req, res) => {
        if (getHeaderValue(req, "mcp-session-id")) {
            await handleStreamableHttpRequest(req, res);
            return;
        }
        const transport = new SSEServerTransport("/message", res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);
        console.error(`[CLIENT] Connected via SSE (session: ${sessionId})`);
        await logDebug(`Client connected: session=${sessionId}`);
        transport.onclose = () => {
            transports.delete(sessionId);
            console.error(`[CLIENT] Disconnected (session: ${sessionId})`);
            logDebug(`Client disconnected: session=${sessionId}`).catch(() => { });
        };
        // Create a new server instance for each session to support concurrent clients
        const server = createServerForSession();
        await server.connect(transport);
    });
    // Deprecated HTTP+SSE message endpoint - route to correct transport.
    app.post("/message", async (req, res) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            res.status(400).json({ error: "Missing sessionId query parameter" });
            return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
            res.status(404).json({ error: `Session ${sessionId} not found` });
            return;
        }
        if (!(transport instanceof SSEServerTransport)) {
            sendJsonRpcError(res, 400, -32000, "Bad Request: Session exists but uses a different transport protocol");
            return;
        }
        try {
            await transport.handlePostMessage(req, res, req.body);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[ERROR] Failed to handle message for session ${sessionId}: ${msg}`);
            await logDebug(`Message error: session=${sessionId}, error=${msg}`);
            if (!res.headersSent) {
                res.status(500).json({ error: msg });
            }
        }
    });
    const httpServer = app.listen(port, host, () => {
        console.error(`[READY] MCP Remote Code Server running on http://${host}:${port}`);
        console.error(`[INFO] Streamable HTTP endpoint: http://${host}:${port}/sse`);
        console.error(`[INFO] Alternate Streamable HTTP endpoint: http://${host}:${port}/mcp`);
        console.error(`[INFO] Legacy SSE endpoint: http://${host}:${port}/sse`);
        console.error(`[INFO] Health check: http://${host}:${port}/health`);
        console.error(`[INFO] Machine configs: ${connectionManager.listConfigs().length}`);
        console.error(`[INFO] Active connections: ${connectionManager.list().length}`);
    });
    async function closeTransports() {
        for (const transport of Array.from(transports.values())) {
            await transport.close().catch(() => { });
        }
        transports.clear();
    }
    // Handle cleanup on exit
    process.on("SIGINT", async () => {
        console.error("[SHUTDOWN] Closing all connections...");
        await closeTransports();
        await connectionManager.closeAll();
        httpServer.close(() => {
            process.exit(0);
        });
    });
    process.on("SIGTERM", async () => {
        console.error("[SHUTDOWN] Closing all connections...");
        await closeTransports();
        await connectionManager.closeAll();
        httpServer.close(() => {
            process.exit(0);
        });
    });
}
main().catch(async (error) => {
    console.error("Fatal error in main():", error);
    await logDebug(`Fatal error: ${error.message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map