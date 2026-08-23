import { z } from "zod";
import { resolveUnderRoot, resolveUnderRootSync } from "./root-jail.js";
export const targetSchema = z
    .string()
    .optional()
    .describe("Target name when multiple remotes are configured. Omit when only one target is connected.");
export function requireConnection(connectionManager, target) {
    const conn = connectionManager.get(target);
    if (conn)
        return conn;
    const targets = connectionManager.list();
    if (targets.length === 0) {
        return {
            errorText: "No remote connections available. Start the server with --remote/--root or a targets config file.",
        };
    }
    if (target) {
        return {
            errorText: `Target "${target}" not found. Available targets: ${connectionManager.targetNames().join(", ")}`,
        };
    }
    if (targets.length > 1) {
        return {
            errorText: `Multiple targets configured (${connectionManager.targetNames().join(", ")}). Specify the target parameter.`,
        };
    }
    return { errorText: "Remote connection not available." };
}
export function textResult(text) {
    return { content: [{ type: "text", text }] };
}
export async function jailRemotePath(conn, input, options) {
    const result = await resolveUnderRoot(conn.config.remoteWorkdir, input, conn.sshPool, options);
    if (result.error) {
        return { errorText: result.error };
    }
    return { path: result.path };
}
export function jailRemoteDir(conn, input) {
    const target = input || conn.config.remoteWorkdir;
    const result = resolveUnderRootSync(conn.config.remoteWorkdir, target);
    if (result.error) {
        return { errorText: result.error };
    }
    return { path: result.path };
}
//# sourceMappingURL=tool-utils.js.map