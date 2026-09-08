import type { SSHPool } from "./ssh-pool.js";
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
export declare const BULK_FILE_THRESHOLD = 50;
/**
 * Tear down both ends of a failed transfer (review F-38).
 *
 * Returning from a failed pipeline without doing this left the SSH channel
 * held: nothing had closed the stream, so the slot came back only when the
 * 30-minute exec timeout fired. Six such failures exhaust the channel cap and
 * the target looks hung.
 */
export declare function abandonTransfer(t: {
    stream: unknown;
    child: {
        kill: (signal?: NodeJS.Signals) => boolean;
    };
    done: Promise<unknown>;
}): Promise<void>;
export declare function shouldUseBulk(fileCount: number): boolean;
/** True when the remote has a tar that can stream to stdout. */
export declare function remoteHasTar(sshPool: SSHPool): Promise<boolean>;
/**
 * Pull remoteDir into localDir. Both must already exist locally.
 * Returns false if the remote side failed, so the caller can fall back.
 */
export declare function pullDirectoryViaTar(sshPool: SSHPool, remoteDir: string, localDir: string): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Push localDir into remoteDir, which is created if missing.
 * Returns false if either side failed, so the caller can fall back.
 */
export declare function pushDirectoryViaTar(sshPool: SSHPool, localDir: string, remoteDir: string): Promise<{
    ok: boolean;
    error?: string;
}>;
