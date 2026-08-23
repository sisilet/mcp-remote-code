import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection-manager.js";
export declare function evaluateBashExecution(root: string, cwd?: string, outside?: boolean): {
    actualCwd: string;
    needsOutsideConfirm: boolean;
};
export declare function handleRemoteBash(connectionManager: ConnectionManager, args: {
    target?: string;
    command: string;
    description: string;
    timeout?: number;
    cwd?: string;
    outside?: boolean;
    force?: boolean;
}): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export declare function createRemoteBashTool(server: McpServer, connectionManager: ConnectionManager): void;
