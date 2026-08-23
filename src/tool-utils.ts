import { z } from "zod"
import type { Connection, ConnectionManager } from "./connection-manager.js"
import { resolveUnderRoot, resolveUnderRootSync } from "./root-jail.js"

export const targetSchema = z
  .string()
  .optional()
  .describe("Target name when multiple remotes are configured. Omit when only one target is connected.")

export function requireConnection(
  connectionManager: ConnectionManager,
  target?: string
): Connection | { errorText: string } {
  const conn = connectionManager.get(target)
  if (conn) return conn

  const targets = connectionManager.list()
  if (targets.length === 0) {
    return {
      errorText:
        "No remote connections available. Start the server with --remote/--root or a targets config file.",
    }
  }
  if (target) {
    return {
      errorText: `Target "${target}" not found. Available targets: ${connectionManager.targetNames().join(", ")}`,
    }
  }
  if (targets.length > 1) {
    return {
      errorText: `Multiple targets configured (${connectionManager.targetNames().join(", ")}). Specify the target parameter.`,
    }
  }
  return { errorText: "Remote connection not available." }
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

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

export function jailRemoteDir(
  conn: Connection,
  input?: string
): { path: string } | { errorText: string } {
  const target = input || conn.config.remoteWorkdir
  const result = resolveUnderRootSync(conn.config.remoteWorkdir, target)
  if (result.error) {
    return { errorText: result.error }
  }
  return { path: result.path! }
}
