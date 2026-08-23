import path from "path"
import type { SSHPool } from "./ssh-pool.js"
import { quoteShell } from "./shell-quote.js"

export interface RootJailResult {
  path?: string
  error?: string
}

export function isUnderRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.posix.normalize(root)
  const normalized = path.posix.normalize(candidate)
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/")
}

export function resolveUnderRootSync(root: string, input: string): RootJailResult {
  let remotePath = path.posix.normalize(input)
  if (!path.posix.isAbsolute(remotePath)) {
    remotePath = path.posix.join(root, input)
    remotePath = path.posix.normalize(remotePath)
  }
  if (!isUnderRoot(root, remotePath)) {
    return { error: `Path "${input}" is outside the allowed root "${root}"` }
  }
  return { path: remotePath }
}

export async function resolveUnderRoot(
  root: string,
  input: string,
  sshPool: SSHPool,
  options?: { forNewFile?: boolean; allowMissing?: boolean }
): Promise<RootJailResult> {
  const sync = resolveUnderRootSync(root, input)
  if (sync.error) return sync
  const remotePath = sync.path!

  if (options?.forNewFile) {
    const parent = path.posix.dirname(remotePath)
    const resolvedParent = await remoteRealpath(sshPool, parent)
    if (!resolvedParent) {
      return { error: `Parent directory does not exist for "${input}"` }
    }
    if (!isUnderRoot(root, resolvedParent)) {
      return { error: `Parent path for "${input}" is outside the allowed root "${root}"` }
    }
    const finalPath = path.posix.join(resolvedParent, path.posix.basename(remotePath))
    if (!isUnderRoot(root, finalPath)) {
      return { error: `Path "${input}" is outside the allowed root "${root}"` }
    }
    return { path: finalPath }
  }

  const resolved = await remoteRealpath(sshPool, remotePath)
  if (!resolved) {
    if (options?.allowMissing && isUnderRoot(root, remotePath)) {
      return { path: remotePath }
    }
    return { error: `Path not found: ${remotePath}` }
  }
  if (!isUnderRoot(root, resolved)) {
    return { error: `Path "${input}" resolves outside the allowed root "${root}"` }
  }
  return { path: resolved }
}

export async function remoteRealpath(sshPool: SSHPool, remotePath: string): Promise<string | null> {
  const quoted = quoteShell(remotePath)
  const result = await sshPool.exec(
    `if [ -e ${quoted} ]; then readlink -f ${quoted} 2>/dev/null || realpath ${quoted} 2>/dev/null || echo ${quoted}; else echo __MISSING__; fi`,
    { timeout: 10_000 }
  )
  const line = result.stdout.trim().split("\n").pop()?.trim()
  if (!line || line === "__MISSING__") return null
  return path.posix.normalize(line)
}
