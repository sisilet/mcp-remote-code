import type { RemoteConfig } from "./config.js";
import type { ManifestManager } from "./manifest.js";
import type { PathMapper } from "./path-mapper.js";
import type { SSHPool } from "./ssh-pool.js";
export declare class SyncEngine {
    private pathMapper;
    private manifest;
    private sshPool;
    private mutex;
    constructor(_config: RemoteConfig, pathMapper: PathMapper, manifest: ManifestManager, sshPool: SSHPool);
    private withLock;
    /** Pull all tracked files from remote to local mirror */
    pullAll(): Promise<void>;
    /**
     * Pull the given files from remote to local mirror. Returns, per path,
     * whether the file existed on the remote. A missing remote file leaves an
     * empty local file (patches that add files rely on this).
     */
    pull(remotePaths: string[]): Promise<boolean[]>;
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
    push(remotePaths: string[]): Promise<void>;
    /**
     * Push all tracked files. Kept for callers that have just pulled everything
     * and therefore hold a fresh mirror; do NOT call this after writing a single
     * file. Prefer push([...]).
     */
    pushAll(): Promise<void>;
    /** Register a new remote file and ensure its parent directory exists locally */
    register(remotePath: string): Promise<string>;
    private runSftp;
}
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
export declare function sftpFastPut(sftp: any, localPath: string, remotePath: string): Promise<void>;
