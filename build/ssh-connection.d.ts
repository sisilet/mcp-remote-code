import { Client } from "ssh2";
import type { RemoteConfig } from "./config.js";
export { exitCodeFrom, appendSignal } from "./ssh-pool.js";
import { type SSHPool } from "./ssh-pool.js";
/**
 * Injection point for tests. The lifecycle paths that matter here — reconnect
 * races, a transport dying with callers queued, a timeout landing before the
 * channel opens — are unreachable from a test that needs a real SSH server,
 * which is why they carried three defects at once (review F-31, F-32, F-34).
 */
export interface SSHConnectionDeps {
    connect?: (config: RemoteConfig) => Promise<Client>;
}
export declare function createSSHConnection(config: RemoteConfig, deps?: SSHConnectionDeps): Promise<SSHPool>;
export declare function isChannelOpenFailure(err: Error): boolean;
/**
 * Run `attempt`, retrying only where retrying cannot change what the remote
 * did (review F-3, and F-26 for the half-fix).
 *
 * Two failures look similar and are not:
 *
 *  - A refused channel (MaxSessions contention) means the command never
 *    started. Re-running it is always safe, whatever the caller asked for.
 *  - A transport that dies mid-command means the command may have run,
 *    partly or fully. Re-running `mv`, `rm` or `>>` then applies it twice.
 *    Only the caller knows whether that is acceptable, so this is gated on
 *    an explicit `retry: true`. `remote_bash` passes `retry: false` and must
 *    get exactly one execution.
 *
 * `onConnectionError` fires whether or not the call will be retried, because
 * the dead transport has to be dropped either way.
 */
export declare function execWithRetry<T>(attempt: () => Promise<T>, options?: {
    retry?: boolean;
    onConnectionError?: (err: Error) => void;
    delay?: (ms: number) => Promise<void>;
}): Promise<T>;
