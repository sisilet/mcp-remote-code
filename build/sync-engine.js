import fs from "fs/promises";
import path from "path";
export class SyncEngine {
    pathMapper;
    manifest;
    sshPool;
    mutex = Promise.resolve();
    constructor(_config, pathMapper, manifest, sshPool) {
        this.pathMapper = pathMapper;
        this.manifest = manifest;
        this.sshPool = sshPool;
    }
    async withLock(fn) {
        const release = this.mutex;
        let resolveRelease;
        this.mutex = new Promise((resolve) => {
            resolveRelease = resolve;
        });
        await release;
        try {
            return await fn();
        }
        finally {
            resolveRelease();
        }
    }
    /** Pull all tracked files from remote to local mirror */
    async pullAll() {
        await this.withLock(async () => {
            const files = this.manifest.remotePaths();
            if (files.length === 0)
                return;
            await this.runSftp("pull", files);
        });
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
     */
    async push(remotePaths) {
        await this.withLock(async () => {
            if (remotePaths.length === 0)
                return;
            await this.runSftp("push", remotePaths);
        });
    }
    /**
     * Push all tracked files. Kept for callers that have just pulled everything
     * and therefore hold a fresh mirror; do NOT call this after writing a single
     * file. Prefer push([...]).
     */
    async pushAll() {
        await this.push(this.manifest.remotePaths());
    }
    /** Register a new remote file and ensure its parent directory exists locally */
    async register(remotePath) {
        const rel = this.manifest.register(remotePath);
        const localPath = this.pathMapper.toLocal(remotePath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await this.manifest.save();
        return rel;
    }
    async runSftp(direction, remotePaths) {
        await this.sshPool.withSftp(async (sftp) => {
            for (const rp of remotePaths) {
                const localPath = this.pathMapper.toLocal(rp);
                if (direction === "pull") {
                    // Ensure local parent dir exists
                    await fs.mkdir(path.dirname(localPath), { recursive: true }).catch(() => { });
                    try {
                        await sftpFastGet(sftp, rp, localPath);
                    }
                    catch (err) {
                        // If remote file does not exist, create an empty local file
                        // (handles "add file" patches where the file is new)
                        const msg = err.message.toLowerCase();
                        if (msg.includes("no such file") || msg.includes("not found")) {
                            await fs.writeFile(localPath, "", "utf-8");
                        }
                        else {
                            throw err;
                        }
                    }
                }
                else {
                    // Ensure remote parent dir exists
                    const remoteDir = path.posix.dirname(rp);
                    await this.sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { retry: true, timeout: 10_000 }).catch(() => { });
                    await sftpFastPut(sftp, localPath, rp);
                }
            }
        });
    }
}
function sftpFastGet(sftp, remotePath, localPath) {
    return new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
}
const call = (fn) => new Promise((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))));
/** Resolves rather than rejects: used where failure is tolerable. */
const tryCall = (fn) => new Promise((resolve) => fn((err) => resolve(!err)));
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
export async function sftpFastPut(sftp, localPath, remotePath) {
    const dir = remotePath.slice(0, remotePath.lastIndexOf("/") + 1);
    const base = remotePath.slice(remotePath.lastIndexOf("/") + 1);
    const stamp = `${process.pid}-${Date.now()}`;
    const tempPath = `${dir}.${base}.mcp-tmp-${stamp}`;
    const backupPath = `${dir}.${base}.mcp-bak-${stamp}`;
    // Mode of the file being replaced, so the replacement does not silently
    // become whatever the server's umask produces.
    const previousMode = await new Promise((resolve) => {
        sftp.stat(remotePath, (err, stats) => resolve(err ? undefined : stats?.mode));
    });
    await call((cb) => sftp.fastPut(localPath, tempPath, cb));
    if (previousMode !== undefined && typeof sftp.chmod === "function") {
        await tryCall((cb) => sftp.chmod(tempPath, previousMode & 0o7777, cb));
    }
    // Move the existing file aside. Absent target: nothing to preserve.
    const backedUp = await tryCall((cb) => sftp.rename(remotePath, backupPath, cb));
    try {
        await call((cb) => sftp.rename(tempPath, remotePath, cb));
    }
    catch (err) {
        // Put the original back before surfacing the failure. The temp is only
        // removed after the original is safe.
        if (backedUp) {
            const restored = await tryCall((cb) => sftp.rename(backupPath, remotePath, cb));
            if (!restored) {
                throw new Error(`Upload of ${remotePath} failed and the original could not be restored. ` +
                    `The previous contents are at ${backupPath}. Original error: ${err.message}`);
            }
        }
        await tryCall((cb) => sftp.unlink(tempPath, cb));
        throw err;
    }
    if (backedUp) {
        await tryCall((cb) => sftp.unlink(backupPath, cb));
    }
}
import { quoteShell } from "./shell-quote.js";
//# sourceMappingURL=sync-engine.js.map