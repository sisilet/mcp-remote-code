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
interface HunkUnified {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
}
interface UnifiedDiffFile {
    oldPath: string | null;
    newPath: string | null;
    hunks: HunkUnified[];
    isNew: boolean;
    isDeleted: boolean;
}
export declare function parseUnifiedPatch(patchText: string): UnifiedDiffFile[];
export declare function detectNoNewlineAtEnd(hunks: HunkUnified[]): boolean;
export declare function applyUnifiedDiff(content: string, hunks: HunkUnified[], hasNoNewlineMarker: boolean): string;
export declare function createRemotePatchTool(server: McpServer, connectionManager: ConnectionManager): void;
export declare function parseAndPrepareNative(patchText: string, remoteWorkdir: string, pathMapper: any): Promise<Array<{
    path: string;
    apply: (content: string) => string;
    moveFrom?: string;
    remove?: boolean;
}>>;
export {};
