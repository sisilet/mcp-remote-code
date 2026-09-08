import fs from "fs/promises"
import path from "path"
import type { RemoteConfig } from "./config.js"
import type { ManifestManager } from "./manifest.js"
import type { PathMapper } from "./path-mapper.js"
import type { SSHPool } from "./ssh-pool.js"

export class SyncEngine {
  private mutex = Promise.resolve()

  constructor(
    _config: RemoteConfig,
    private pathMapper: PathMapper,
    private manifest: ManifestManager,
    private sshPool: SSHPool
  ) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.mutex
    let resolveRelease: () => void
    this.mutex = new Promise((resolve) => {
      resolveRelease = resolve
    })
    await release
    try {
      return await fn()
    } finally {
      resolveRelease!()
    }
  }

  /** Pull all tracked files from remote to local mirror */
  async pullAll(): Promise<void> {
    await this.pull(this.manifest.remotePaths())
  }

  /**
   * Pull the given files from remote to local mirror. Returns, per path,
   * whether the file existed on the remote. A missing remote file leaves an
   * empty local file (patches that add files rely on this).
   */
  async pull(remotePaths: string[]): Promise<boolean[]> {
    return this.withLock(async () => {
      if (remotePaths.length === 0) return []
      return this.runSftp("pull", remotePaths)
    })
  }

  /**
   * Push only the given files from local mirror to remote.
   *
   * Tools must push exactly what they changed. pushAll() used to be called
   * after every remote_write, which uploaded the mirror's copy of EVERY file
   * tracked in the session. The mirror is only refreshed from the remote when
   * the target file already exists locally, so writing a NEW file skipped the
   * pull and then overwrote every earlier file with a stale copy, silently
   * destroying any change made on the remote outside this tool (2026-09-08:
   * two scripts lost hours of edits this way).
   *
   * Guard: before each upload the remote is stat'ed and compared with the stamp
   * recorded at the last pull. A mismatch means the remote changed underneath
   * us; the push is refused with an error rather than overwriting. A remote
   * file that exists but was never pulled is refused for the same reason.
   */
  async push(remotePaths: string[]): Promise<void> {
    await this.withLock(async () => {
      if (remotePaths.length === 0) return
      await this.runSftp("push", remotePaths)
    })
  }

  /**
   * Push all tracked files. Kept for callers that have just pulled everything
   * and therefore hold a fresh mirror; do NOT call this after writing a single
   * file. Prefer push([...]).
   */
  async pushAll(): Promise<void> {
    await this.push(this.manifest.remotePaths())
  }

  /** Register a new remote file and ensure its parent directory exists locally */
  async register(remotePath: string): Promise<string> {
    const rel = this.manifest.register(remotePath)
    const localPath = this.pathMapper.toLocal(remotePath)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await this.manifest.save()
    return rel
  }

  private async runSftp(direction: "pull" | "push", remotePaths: string[]): Promise<boolean[]> {
    const existed: boolean[] = []
    await this.sshPool.withSftp(async (sftp) => {
      for (const rp of remotePaths) {
        const localPath = this.pathMapper.toLocal(rp)

        if (direction === "pull") {
          // Ensure local parent dir exists
          await fs.mkdir(path.dirname(localPath), { recursive: true }).catch(() => {})
          try {
            await sftpFastGet(sftp, rp, localPath)
            // Remember what the remote looked like when we took this copy.
            const stamp = await remoteStamp(sftp, rp)
            if (stamp) this.manifest.setPulled(rp, stamp)
            existed.push(true)
          } catch (err) {
            // If remote file does not exist, create an empty local file
            // (handles "add file" patches where the file is new)
            const msg = (err as Error).message.toLowerCase()
            if (msg.includes("no such file") || msg.includes("not found")) {
              await fs.writeFile(localPath, "", "utf-8")
              existed.push(false)
            } else {
              throw err
            }
          }
        } else {
          // Refuse to overwrite a remote file that changed since we last saw it.
          const current = await remoteStamp(sftp, rp)
          const seen = this.manifest.getPulled(rp)
          if (current !== undefined && seen === undefined) {
            throw new Error(
              `Refusing to push ${rp}: the file exists on the remote but was never pulled into ` +
              `the local mirror, so its current contents are unknown. Read it first (remote_read), then retry.`
            )
          }
          if (current !== undefined && seen !== undefined && current !== seen) {
            throw new Error(
              `Refusing to push ${rp}: it changed on the remote since it was last pulled ` +
              `(remote mtime:size ${current}, last seen ${seen}). Something outside this tool ` +
              `edited it. Re-read the file, reapply your change, and retry.`
            )
          }
          // Ensure remote parent dir exists
          const remoteDir = path.posix.dirname(rp)
          await this.sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { retry: true, timeout: 10_000 }).catch(() => {})
          await sftpFastPut(sftp, localPath, rp)
          const after = await remoteStamp(sftp, rp)
          if (after) this.manifest.setPulled(rp, after)
        }
      }
    })
    await this.manifest.save()
    return existed
  }
}

/** "mtime:size" of a remote file, or undefined if it does not exist. */
function remoteStamp(sftp: any, remotePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err: Error | undefined, stats: any) => {
      if (err || !stats) return resolve(undefined)
      resolve(`${stats.mtime}:${stats.size}`)
    })
  })
}

function sftpFastGet(
  sftp: any,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err: Error | undefined) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

const call = <T>(fn: (cb: (err: Error | undefined, result?: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) =>
    fn((err, result) => (err ? reject(err) : resolve(result as T)))
  )

/** Resolves rather than rejects: used where failure is tolerable. */
const tryCall = (fn: (cb: (err?: Error) => void) => void): Promise<boolean> =>
  new Promise((resolve) => fn((err) => resolve(!err)))

/**
 * Upload atomically: write a sibling temp file, then rename over the target
 * (review F-12). A direct fastPut that fails partway leaves the destination
 * truncated, which is how a good file becomes a broken one. rename(2) within
 * the same directory is atomic on POSIX filesystems.
 *
 * The ordering matters, and the first version got it wrong (review F-27). It
 * unlinked the target before the rename, and its error path deleted the temp
 * as well, so a failed rename left neither the old file nor the new one. That
 * is worse than the truncation F-12 set out to prevent: truncation loses the
 * contents, this lost the file.
 *
 * So the target is moved aside rather than deleted, and it is only discarded
 * once the new content holds the real name. At every instant between the
 * first write and the last unlink, the full old contents or the full new
 * contents exist under some name on the remote.
 */
export async function sftpFastPut(
  sftp: any,
  localPath: string,
  remotePath: string
): Promise<void> {
  const dir = remotePath.slice(0, remotePath.lastIndexOf("/") + 1)
  const base = remotePath.slice(remotePath.lastIndexOf("/") + 1)
  const stamp = `${process.pid}-${Date.now()}`
  const tempPath = `${dir}.${base}.mcp-tmp-${stamp}`
  const backupPath = `${dir}.${base}.mcp-bak-${stamp}`

  // Mode of the file being replaced, so the replacement does not silently
  // become whatever the server's umask produces.
  const previousMode = await new Promise<number | undefined>((resolve) => {
    sftp.stat(remotePath, (err: Error | undefined, stats: any) =>
      resolve(err ? undefined : (stats?.mode as number | undefined))
    )
  })

  await call<void>((cb) => sftp.fastPut(localPath, tempPath, cb))

  if (previousMode !== undefined && typeof sftp.chmod === "function") {
    await tryCall((cb) => sftp.chmod(tempPath, previousMode & 0o7777, cb))
  }

  // Move the existing file aside. Absent target: nothing to preserve.
  const backedUp = await tryCall((cb) => sftp.rename(remotePath, backupPath, cb))

  try {
    await call<void>((cb) => sftp.rename(tempPath, remotePath, cb))
  } catch (err) {
    // Put the original back before surfacing the failure. The temp is only
    // removed after the original is safe.
    if (backedUp) {
      const restored = await tryCall((cb) => sftp.rename(backupPath, remotePath, cb))
      if (!restored) {
        throw new Error(
          `Upload of ${remotePath} failed and the original could not be restored. ` +
          `The previous contents are at ${backupPath}. Original error: ${(err as Error).message}`
        )
      }
    }
    await tryCall((cb) => sftp.unlink(tempPath, cb))
    throw err
  }

  if (backedUp) {
    await tryCall((cb) => sftp.unlink(backupPath, cb))
  }
}

import { quoteShell } from "./shell-quote.js"
