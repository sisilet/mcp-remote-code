import { spawn } from "child_process"
import { pipeline } from "stream/promises"
import type { SSHPool } from "./ssh-pool.js"
import { quoteShell } from "./shell-quote.js"

/**
 * Directory transfer by streaming tar over one SSH channel (review P-8,
 * decision D-D).
 *
 * Per-file SFTP costs a round trip per file, which dominates on trees of many
 * small files: the 26,000-file WhatsApp directory on this network is the
 * motivating case. One tar stream is typically 5 to 10x faster there.
 *
 * For a handful of files the setup cost is not worth it, so callers use
 * shouldUseBulk() and fall back to the existing per-file path.
 */

/** Below this file count, per-file SFTP is simpler and about as fast. */
export const BULK_FILE_THRESHOLD = 50

/** How long to wait for a failed transfer's channel to close before giving up. */
const TEARDOWN_TIMEOUT_MS = 5_000

/**
 * Tear down both ends of a failed transfer (review F-38).
 *
 * Returning from a failed pipeline without doing this left the SSH channel
 * held: nothing had closed the stream, so the slot came back only when the
 * 30-minute exec timeout fired. Six such failures exhaust the channel cap and
 * the target looks hung.
 */
export async function abandonTransfer(t: {
  stream: unknown
  child: { kill: (signal?: NodeJS.Signals) => boolean }
  done: Promise<unknown>
}): Promise<void> {
  try { (t.stream as any)?.destroy?.() } catch {}
  try { (t.stream as any)?.close?.() } catch {}
  try { t.child.kill("SIGKILL") } catch {}
  // Give the channel a moment to close on its own; never block on it.
  await Promise.race([
    t.done.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, TEARDOWN_TIMEOUT_MS)),
  ])
}

export function shouldUseBulk(fileCount: number): boolean {
  return fileCount >= BULK_FILE_THRESHOLD
}

/** True when the remote has a tar that can stream to stdout. */
export async function remoteHasTar(sshPool: SSHPool): Promise<boolean> {
  try {
    const r = await sshPool.exec("command -v tar >/dev/null 2>&1 && echo yes", {
      retry: true,
      timeout: 10_000,
    })
    return r.stdout.trim() === "yes"
  } catch {
    return false
  }
}

/**
 * Pull remoteDir into localDir. Both must already exist locally.
 * Returns false if the remote side failed, so the caller can fall back.
 */
export async function pullDirectoryViaTar(
  sshPool: SSHPool,
  remoteDir: string,
  localDir: string
): Promise<{ ok: boolean; error?: string }> {
  // -C so paths in the archive are relative to remoteDir, not absolute.
  //
  // -h dereferences symlinks, so the archive contains regular files and
  // directories and nothing else (review F-37). Extracting an archive that
  // contains symlink members is the classic tar-slip: a member `link ->
  // /Users/me/.ssh` followed by `link/authorized_keys` writes outside the
  // extraction directory, and this is the one path in the whole design where
  // the remote decides what happens on the local machine. Rather than depend
  // on the local tar refusing that — behaviour that differs between bsdtar
  // and GNU tar — no such member is created in the first place.
  //
  // The cost is that a symlinked file in the mirror becomes a copy of its
  // target. For a scratch mirror used to read and patch files, that is the
  // right trade.
  const cmd = `tar -cf - -h -C ${quoteShell(remoteDir)} .`
  const { stdout, done } = await sshPool.execStream(cmd, { timeout: 30 * 60_000 })

  const extract = spawn("tar", ["-xf", "-", "-C", localDir])
  const extractDone = new Promise<number>((resolve) => {
    extract.on("close", (code) => resolve(code ?? 0))
  })

  try {
    await pipeline(stdout as any, extract.stdin)
  } catch (err) {
    // Tear both sides down rather than returning and leaving the SSH channel
    // held until its 30-minute timeout expires (review F-38).
    await abandonTransfer({ stream: stdout, child: extract, done })
    return { ok: false, error: `stream failed: ${(err as Error).message}` }
  }

  const [remote, localCode] = await Promise.all([done, extractDone])
  if (remote.exitCode !== 0) {
    return { ok: false, error: `remote tar exited ${remote.exitCode}: ${remote.stderr.slice(0, 200)}` }
  }
  if (localCode !== 0) {
    return { ok: false, error: `local tar exited ${localCode}` }
  }
  return { ok: true }
}

/**
 * Push localDir into remoteDir, which is created if missing.
 * Returns false if either side failed, so the caller can fall back.
 */
export async function pushDirectoryViaTar(
  sshPool: SSHPool,
  localDir: string,
  remoteDir: string
): Promise<{ ok: boolean; error?: string }> {
  await sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { retry: true, timeout: 15_000 })

  const cmd = `tar -xf - -C ${quoteShell(remoteDir)}`
  const { stdin, done } = await sshPool.execStream(cmd, { timeout: 30 * 60_000 })

  const create = spawn("tar", ["-cf", "-", "-C", localDir, "."])
  try {
    // pipeline() ends the writable side, but an ssh2 channel stays open
    // because its readable half is still live, so the remote `tar -xf -`
    // waits forever for EOF. end() on the channel sends the EOF the remote
    // needs. Symptom without it: the files arrive, then the call hangs.
    await pipeline(create.stdout, stdin as any, { end: false })
    await new Promise<void>((resolve) => (stdin as any).end(resolve))
  } catch (err) {
    await abandonTransfer({ stream: stdin, child: create, done })
    return { ok: false, error: `stream failed: ${(err as Error).message}` }
  }

  const remote = await done
  if (remote.exitCode !== 0) {
    return { ok: false, error: `remote tar exited ${remote.exitCode}: ${remote.stderr.slice(0, 200)}` }
  }
  return { ok: true }
}
