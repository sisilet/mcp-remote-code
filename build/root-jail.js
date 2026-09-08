import path from "path";
import { quoteShell } from "./shell-quote.js";
export function isUnderRoot(root, candidate) {
    const normalizedRoot = path.posix.normalize(root);
    const normalized = path.posix.normalize(candidate);
    if (normalized === normalizedRoot)
        return true;
    // A root of "/" already ends with the separator; appending another would
    // produce "//" and reject every path. Fixed 2026-09-06 (review F-2).
    const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
    return normalized.startsWith(prefix);
}
export function resolveUnderRootSync(root, input) {
    let remotePath = path.posix.normalize(input);
    if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(root, input);
        remotePath = path.posix.normalize(remotePath);
    }
    if (!isUnderRoot(root, remotePath)) {
        return { error: `Path "${input}" is outside the allowed root "${root}"` };
    }
    return { path: remotePath };
}
export async function resolveUnderRoot(root, input, sshPool, options) {
    const sync = resolveUnderRootSync(root, input);
    if (sync.error)
        return sync;
    const remotePath = sync.path;
    if (options?.forNewFile) {
        const parent = path.posix.dirname(remotePath);
        const resolvedParent = await remoteRealpath(sshPool, parent, root);
        if (!resolvedParent) {
            return { error: `Parent directory does not exist for "${input}"` };
        }
        if (!isUnderRoot(root, resolvedParent)) {
            return { error: `Parent path for "${input}" is outside the allowed root "${root}"` };
        }
        const finalPath = path.posix.join(resolvedParent, path.posix.basename(remotePath));
        if (!isUnderRoot(root, finalPath)) {
            return { error: `Path "${input}" is outside the allowed root "${root}"` };
        }
        // Resolving the parent is not enough when the destination itself already
        // exists and is a symlink (review F-29): the parent is inside the root,
        // the name is inside the root, and writing to it lands wherever the link
        // points. SFTP fastPut and shell redirection both follow it.
        const resolvedFinal = await remoteRealpath(sshPool, finalPath, root);
        if (resolvedFinal && !isUnderRoot(root, resolvedFinal)) {
            return { error: `Path "${input}" resolves outside the allowed root "${root}"` };
        }
        return { path: finalPath };
    }
    const resolved = await remoteRealpath(sshPool, remotePath, root);
    if (!resolved) {
        if (options?.allowMissing && isUnderRoot(root, remotePath)) {
            return { path: remotePath };
        }
        return { error: `Path not found: ${remotePath}` };
    }
    if (!isUnderRoot(root, resolved)) {
        return { error: `Path "${input}" resolves outside the allowed root "${root}"` };
    }
    return { path: resolved };
}
/**
 * Does this server's SFTP subsystem see the same filesystem paths as its
 * shell? Cached per pool, probed once.
 *
 * Not theoretical: on a Synology DS220j, SFTP sessions for a non-admin user
 * are offset to the volume root, so shell "/volume1/homes/eric" is SFTP
 * "/homes/eric" and the shell path does not exist in the SFTP namespace at
 * all. `sshd_config` reports `ChrootDirectory none`, so this cannot be
 * detected by reading configuration; it has to be measured.
 *
 * Resolving a path in one namespace and judging it against a root expressed
 * in the other produces wrong answers, and for a security check wrong answers
 * are unacceptable. When the namespaces disagree, resolution uses the shell.
 */
const sftpNamespaceOk = new WeakMap();
function sftpMatchesShell(sshPool, _root) {
    let probe = sftpNamespaceOk.get(sshPool);
    if (!probe) {
        probe = (async () => {
            try {
                // Compare where each subsystem thinks the login directory is. An
                // earlier version probed lstat(root), which is useless when the root
                // is "/": that succeeds inside any chroot and gave a false positive
                // on the DS220j, where SFTP "/" is actually shell "/volume1".
                const [shellPwd, sftpPwd] = await Promise.all([
                    sshPool
                        .exec("pwd -P", { retry: true, timeout: 10_000 })
                        .then((r) => r.stdout.trim())
                        .catch(() => ""),
                    sshPool
                        .withSftp((sftp) => new Promise((resolve) => sftp.realpath(".", (err, target) => resolve(err ? "" : String(target)))))
                        .catch(() => ""),
                ]);
                if (!shellPwd || !sftpPwd)
                    return false;
                const match = path.posix.normalize(shellPwd) === path.posix.normalize(sftpPwd);
                if (!match) {
                    console.error(`[SSH] SFTP paths are offset from shell paths on this server ` +
                        `(shell "${shellPwd}" vs sftp "${sftpPwd}"); using the shell for ` +
                        `path resolution.`);
                }
                return match;
            }
            catch {
                return false;
            }
        })();
        sftpNamespaceOk.set(sshPool, probe);
    }
    return probe;
}
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
export async function remoteRealpath(sshPool, remotePath, root) {
    // Fail safe: without a root there is nothing to probe the SFTP namespace
    // against, so use the shell. The fast path is opt-in by supplying the root,
    // which every jail caller does.
    if (!root || !(await sftpMatchesShell(sshPool, root))) {
        return remoteRealpathViaExec(sshPool, remotePath);
    }
    try {
        return await sshPool.withSftp(async (sftp) => {
            const exists = await new Promise((resolve) => {
                // lstat, not stat: a broken symlink still exists as an entry, and the
                // jail must judge where it points rather than pretend it is absent.
                sftp.lstat(remotePath, (err) => resolve(!err));
            });
            if (!exists)
                return null;
            const resolved = await new Promise((resolve) => {
                sftp.realpath(remotePath, (err, target) => resolve(err ? null : target));
            });
            return resolved ? path.posix.normalize(resolved) : null;
        });
    }
    catch {
        // No SFTP subsystem, or it failed: the shell still works.
        return remoteRealpathViaExec(sshPool, remotePath);
    }
}
async function remoteRealpathViaExec(sshPool, remotePath) {
    const quoted = quoteShell(remotePath);
    const result = await sshPool.exec(`if [ -e ${quoted} ] || [ -L ${quoted} ]; then readlink -f ${quoted} 2>/dev/null || realpath ${quoted} 2>/dev/null || echo ${quoted}; else echo __MISSING__; fi`, { retry: true, timeout: 10_000 });
    const line = result.stdout.trim().split("\n").pop()?.trim();
    if (!line || line === "__MISSING__")
        return null;
    return path.posix.normalize(line);
}
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
export async function resolveManyUnderRoot(root, inputs, sshPool, options) {
    if (inputs.length === 0)
        return [];
    if (inputs.length === 1) {
        return [await resolveUnderRoot(root, inputs[0], sshPool, options)];
    }
    // Reject anything that fails the cheap syntactic check before touching the
    // network at all.
    const pre = inputs.map((input) => resolveUnderRootSync(root, input));
    if (await sftpMatchesShell(sshPool, root)) {
        // Pipelined: the shared SFTP session serialises requests, but without a
        // round trip's latency between each.
        return Promise.all(inputs.map((input, i) => pre[i].error ? Promise.resolve(pre[i]) : resolveUnderRoot(root, input, sshPool, options)));
    }
    if (options?.forNewFile) {
        // The batch script below resolves each path itself, which is the wrong
        // question for a path that does not exist yet: what has to be resolved is
        // its parent. Ignoring that (review F-30) let `remote_patch` create a file
        // through a symlinked parent on exactly the servers that take this branch.
        // Rather than maintain a second script shape for it, defer to the
        // single-path resolver, which gets parents right. Costs the round trips
        // the batch was written to save, on the minority of servers whose SFTP
        // namespace is offset, for the paths where correctness depends on it.
        return Promise.all(inputs.map((input, i) => pre[i].error ? Promise.resolve(pre[i]) : resolveUnderRoot(root, input, sshPool, options)));
    }
    // One shell invocation for every path, instead of one per path.
    const wanted = pre.map((r, i) => ({ i, path: r.path })).filter((x) => x.path);
    const script = wanted
        .map(({ path: p }) => {
        const q = quoteShell(p);
        return `if [ -e ${q} ] || [ -L ${q} ]; then readlink -f ${q} 2>/dev/null || realpath ${q} 2>/dev/null || echo ${q}; else echo __MISSING__; fi`;
    })
        .join("; ");
    const result = await sshPool.exec(script, { retry: true, timeout: 30_000 });
    const lines = result.stdout.split("\n").map((l) => l.trim());
    const out = [...pre];
    wanted.forEach(({ i }, n) => {
        const line = lines[n];
        if (!line || line === "__MISSING__") {
            out[i] = options?.allowMissing
                ? { path: pre[i].path }
                : { error: `Path not found: ${pre[i].path}` };
            return;
        }
        const resolved = path.posix.normalize(line);
        out[i] = isUnderRoot(root, resolved)
            ? { path: resolved }
            : { error: `Path "${inputs[i]}" resolves outside the allowed root "${root}"` };
    });
    return out;
}
//# sourceMappingURL=root-jail.js.map