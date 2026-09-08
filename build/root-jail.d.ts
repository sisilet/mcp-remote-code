import type { SSHPool } from "./ssh-pool.js";
export interface RootJailResult {
    path?: string;
    error?: string;
}
export declare function isUnderRoot(root: string, candidate: string): boolean;
export declare function resolveUnderRootSync(root: string, input: string): RootJailResult;
export declare function resolveUnderRoot(root: string, input: string, sshPool: SSHPool, options?: {
    forNewFile?: boolean;
    allowMissing?: boolean;
}): Promise<RootJailResult>;
/**
 * Resolve a remote path, following symlinks, or null when it does not exist.
 *
 * Prefers SFTP realpath over an `exec` of `readlink -f` (review P-2): every
 * file tool calls this before touching a path, so the exec cost one SSH round
 * trip per operation. Measured 20x faster on a NAS, 2.3x on a Linux host.
 *
 * Verified against a real server that SFTP realpath fully resolves symlinks,
 * including relative and directory links, so a link pointing outside the root
 * still resolves outside it and the jail still catches it.
 *
 * Two semantics matter:
 *  - SFTP realpath does NOT fail for a missing path, it returns the path
 *    unchanged, so existence is checked with lstat first.
 *  - SFTP may be chrooted (see sftpMatchesShell), in which case the shell is
 *    the only trustworthy source.
 */
export declare function remoteRealpath(sshPool: SSHPool, remotePath: string, root?: string): Promise<string | null>;
/**
 * Resolve many paths against the root in as few round trips as possible
 * (review 3.2).
 *
 * `remote_patch` resolves every file it touches, sequentially, so a patch
 * spanning N files cost N round trips. Where SFTP is usable the calls
 * pipeline through the shared session; where it is not (a chrooted or
 * SFTP-less server) they collapse into a single shell command instead of N.
 *
 * Returns results in the same order as `inputs`. Each is either a resolved
 * path or an error, so callers report per-path failures rather than aborting
 * the batch.
 */
export declare function resolveManyUnderRoot(root: string, inputs: string[], sshPool: SSHPool, options?: {
    forNewFile?: boolean;
    allowMissing?: boolean;
}): Promise<RootJailResult[]>;
