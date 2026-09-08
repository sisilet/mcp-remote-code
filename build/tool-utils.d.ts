import { z } from "zod";
import type { Connection, ConnectionManager } from "./connection-manager.js";
export declare const targetSchema: z.ZodOptional<z.ZodString>;
export declare function requireConnection(connectionManager: ConnectionManager, target?: string): Promise<Connection | {
    errorText: string;
}>;
export declare function textResult(text: string): {
    content: {
        type: "text";
        text: string;
    }[];
};
/**
 * Which jail helper a tool should use, by what it is doing to the path
 * (review F-44). These had drifted per tool, so a new tool could pick the
 * weakest by accident:
 *
 *  - **Reading or inspecting** an existing path: `jailRemotePath` with no
 *    options. Missing is an error, and the resolved target must be in root.
 *  - **Reading where absence is a normal answer** (a stat, a "not found"
 *    message): add `allowMissing: true`.
 *  - **Creating or overwriting**: `{ forNewFile: true, allowMissing: true }`.
 *    Resolves the parent, and the destination too when it already exists, so
 *    a symlink cannot be written through.
 *  - **A directory a search will enter**: `jailRemoteDir`, and filter the
 *    results with `keepUnderRoot`.
 *  - **Many paths at once**: `resolveManyUnderRoot`, same options.
 *
 * Never hand a path to an exec or SFTP call that did not come out of one of
 * these, and never build a remote command with a path that did not also go
 * through `quoteShell`.
 */
export declare function jailRemotePath(conn: Connection, input: string, options?: {
    forNewFile?: boolean;
    allowMissing?: boolean;
}): Promise<{
    path: string;
} | {
    errorText: string;
}>;
/**
 * Resolve a directory a search will `cd` into.
 *
 * This used to be a syntactic check only (review F-28), which meant a
 * directory symlink under the root sent `remote_glob` and `remote_grep`
 * outside it while the output still reported the in-root path. Symlinks have
 * to be resolved for the same reason they are resolved for file paths: the
 * jail must judge where the path actually leads.
 */
export declare function jailRemoteDir(conn: Connection, input?: string): Promise<{
    path: string;
} | {
    errorText: string;
}>;
/**
 * Drop any result that falls outside the root. A search rooted inside the
 * jail can still surface paths outside it by following links, so the results
 * are filtered as well as the starting directory.
 */
export declare function keepUnderRoot(conn: Connection, paths: string[]): string[];
