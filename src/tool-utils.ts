import { z } from "zod"
import type { Connection, ConnectionManager } from "./connection-manager.js"
import { isUnderRoot, resolveUnderRoot } from "./root-jail.js"

export const targetSchema = z
  .string()
  .optional()
  .describe("Target name when multiple remotes are configured. Omit when only one target is connected.")

export async function requireConnection(
  connectionManager: ConnectionManager,
  target?: string
): Promise<Connection | { errorText: string }> {
  let conn = connectionManager.get(target)
  if (conn) return conn

  // Lazy reconnect for offline targets (throttled inside ConnectionManager).
  if (target && connectionManager.hasFailed(target)) {
    conn = (await connectionManager.retryFailed(target)) ?? undefined
    if (conn) return conn
  }

  const targets = connectionManager.list()
  const offline = connectionManager.listFailed()
  const available = connectionManager.targetNames()

  if (target) {
    const offlineError = connectionManager.getFailedError(target)
    if (offlineError) {
      const retryAfterMs = connectionManager.getFailedRetryAfterMs(target) ?? 0
      const retryHint =
        retryAfterMs > 0
          ? `Next automatic retry in ~${Math.ceil(retryAfterMs / 1000)}s on the next tool call.`
          : `Will retry automatically on the next tool call.`
      return {
        errorText:
          `Target "${target}" is offline: ${offlineError}. ` +
          `Connected targets: ${available.length > 0 ? available.join(", ") : "(none)"}. ` +
          retryHint,
      }
    }
    return {
      errorText: `Target "${target}" not found. Available targets: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`,
    }
  }

  if (targets.length === 0) {
    const offlineHint =
      offline.length > 0
        ? ` Offline: ${offline.map((f) => `${f.name} (${f.error})`).join("; ")}. ` +
          `Call a tool with target=<name> to retry a specific host.`
        : ""
    return {
      errorText:
        "No remote connections available. Start the server with --config or --ssh/--path." +
        offlineHint,
    }
  }
  if (targets.length > 1) {
    return {
      errorText: `Multiple targets connected (${available.join(", ")}). Specify the target parameter.`,
    }
  }
  return { errorText: "Remote connection not available." }
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

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
export async function jailRemotePath(
  conn: Connection,
  input: string,
  options?: { forNewFile?: boolean; allowMissing?: boolean }
): Promise<{ path: string } | { errorText: string }> {
  const result = await resolveUnderRoot(
    conn.config.remoteWorkdir,
    input,
    conn.sshPool,
    options
  )
  if (result.error) {
    return { errorText: result.error }
  }
  return { path: result.path! }
}

/**
 * Resolve a directory a search will `cd` into.
 *
 * This used to be a syntactic check only (review F-28), which meant a
 * directory symlink under the root sent `remote_glob` and `remote_grep`
 * outside it while the output still reported the in-root path. Symlinks have
 * to be resolved for the same reason they are resolved for file paths: the
 * jail must judge where the path actually leads.
 */
export async function jailRemoteDir(
  conn: Connection,
  input?: string
): Promise<{ path: string } | { errorText: string }> {
  const target = input || conn.config.remoteWorkdir
  const result = await resolveUnderRoot(conn.config.remoteWorkdir, target, conn.sshPool, {
    allowMissing: true,
  })
  if (result.error) {
    return { errorText: result.error }
  }
  return { path: result.path! }
}

/**
 * Drop any result that falls outside the root. A search rooted inside the
 * jail can still surface paths outside it by following links, so the results
 * are filtered as well as the starting directory.
 */
export function keepUnderRoot(conn: Connection, paths: string[]): string[] {
  return paths.filter((p) => isUnderRoot(conn.config.remoteWorkdir, p))
}
