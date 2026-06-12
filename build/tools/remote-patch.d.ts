import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../connection-manager.js";
export type Hunk = {
    type: "add";
    path: string;
    contents: string;
} | {
    type: "delete";
    path: string;
} | {
    type: "update";
    path: string;
    move_path?: string;
    chunks: UpdateFileChunk[];
};
export interface UpdateFileChunk {
    old_lines: string[];
    new_lines: string[];
    change_context?: string;
    is_end_of_file?: boolean;
}
export declare function parsePatch(patchText: string): {
    hunks: Hunk[];
};
export declare function createRemotePatchTool(server: McpServer, connectionManager: ConnectionManager): void;
