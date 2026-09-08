# Code Review: mcp-remote-code v2.1.0

> **Historical.** This is a point-in-time review of v2.1.0. Most of it has been
> remediated, so several findings below — F-4 (no host key verification), F-5
> (no human confirmation), the whole connection-pool performance section — no
> longer describe the code. For current state see `REMEDIATION-PLAN.md` and
> `CODE-REVIEW-2026-09-07.md`.

**Date:** 2026-09-06
**Scope:** all of `src/` (5,031 lines, 27 files), live `~/.mcp-remote-code/targets.json`, test layout.
**Method:** full read of `root-jail.ts`, `shell-quote.ts`, `ssh-pool.ts`, `config.ts`, `connection-manager.ts`, `tool-utils.ts`, `remote-bash.ts`, `confirmation.ts`; targeted reads of the remaining tools; empirical checks where a claim could be tested.
**Companion:** `REMEDIATION-PLAN.md` maps every finding below to a phased change. Finding numbers here are referenced there as F-n.

## Summary

A well-structured project: clear layering (config → connection manager → pool → jail → tools), one gate for every tool call (`requireConnection`), real tests including Docker integration, and the newly added lazy-retry logic is correctly designed. Three critical defects, several of which explain behaviour observed in production use the same day. Ordered by severity.

---

## Critical

### F-1. `console.log` writes into the MCP protocol channel
`ssh-pool.ts:147` (health-check replacement) and `:342` (connection-error retry). This is a stdio MCP server; stdout is the JSON-RPC stream. Both fire during normal operation and inject plain text into the protocol. The client desyncs or hangs.

**Evidence:** repeated "MCP server unresponsive after 4 minutes" failures during a full day of heavy use, several coinciding with long-running commands during which a 30-second health check would have fired. `index.ts:115,119` also use `console.log` but only for `--help`/`--version` before the server starts, which is fine.

### F-2. `isUnderRoot` rejects every path when root is `/`
`root-jail.ts:13`: `normalizedRoot + "/"` yields `"//"` for root `/`, and `"/volume1".startsWith("//")` is false.

**Evidence:** `node -e` reproduction: `isUnderRoot("/", "/volume1")` → `false`; `isUnderRoot("/media", "/media/x")` → `true`. The `nas` target in the live config uses `path: "/"` and would refuse every operation on connect. No test case covers root `/`.

### F-3. Automatic re-execution of arbitrary commands
`execOnPool` retries once on anything `isConnectionError` classifies as a connection error. `remote_bash` runs arbitrary user commands through this path. A command that partially executed before the connection dropped runs again: `mv`, `rm`, `>>`, anything non-idempotent. `isConnectionError` matches substrings such as `"network"` and `"connection"`, so it trips easily.

---

## High

### F-4. No host key verification
`ssh2` accepts any host key when no `hostVerifier` is supplied. The code supplies one only when `StrictHostKeyChecking=no` is passed, and it is `() => true`, identical to the default. There is no MITM protection. The tool authenticates with private keys and executes commands.

### F-5. The "confirmation" has no human in it
`confirmation.ts` requires the *model* to call twice, the second time with `force=true`. Nothing prompts the user. Key is `command + cwd`, which the model simply repeats.

**Evidence:** a full day of `remote_bash` calls across genie's filesystem from a target rooted at an unrelated workspace, zero prompts, because `cwd` was never set outside root.

### F-6. `remote_bash` is not jailed; the README says it is
`evaluateBashExecution` constrains only `cwd`. The command may reference any path. This is a legitimate design limit (bash cannot be jailed without a sandbox), but "jailed root directory" in the README and the tool description is false for this tool and true for the file tools.

---

## Medium

### F-7. Timeout does not kill the remote process
`execOnClient` rejects on timeout, but the remote command keeps running and the channel stays open on a client returned to the pool. Orphans accumulate.

### F-8. Unbounded output accumulation
`stdout += data` with no cap. The 1 MB result limit is enforced downstream by the SDK, after the whole output is buffered. A runaway command can OOM the process. Observed: a `remote_bash` returning multi-megabyte progress output was rejected only after full buffering.

### F-9. `acquire()` can wait forever
Queue has no timeout; the exec timeout starts only after acquire returns. If replenish keeps failing, callers hang indefinitely. A second plausible source of the observed hangs.

### F-10. `sudo` password handling
`\bsudo\b` regex replace mutates command text (matches `sudo` inside strings); only the first `sudo` in a pipeline receives the stdin password; the password is plaintext in `targets.json`. Passwordless `sudo -n` is already configured on the primary target.

### F-11. `targets.json` is world-readable
Mode `-rw-r--r--` while the schema supports plaintext `password` and `sudoPassword`.

### F-12. Remote writes are not atomic
No temp-plus-rename in `remote-write.ts` or `sync-engine.ts`. A crash mid-write leaves a truncated file.

### F-13. Config round-trips through a synthetic `ssh` string
`normalizeTargetEntry` builds `ssh -i key -p port user@host` from structured JSON, then `parseSshCommand` tokenises it back. `withIdentity` and `buildSshCommand` insert the key path unquoted; a path containing a space breaks tokenisation.

### F-14. Health check can overlap itself
`checkHealth` has no re-entrancy guard; `replenish` does (`replenishing`). A slow host pushes a check past the 30 s interval into the next one.

---

## Low

- F-15. `quoteShell` passes through strings beginning with `-`, which downstream commands read as options.
- F-16. `parseInt(process.env.X || "3")` → `NaN` on garbage → zero connections → every `acquire` hangs.
- F-17. `remote_bash` reports exit 0 as failure if stderr contains "permission denied"; `find /` does this legitimately.
- F-18. No `passphrase` support for encrypted keys; `ssh2` fails with an unhelpful message.
- F-19. Default user is `root` when unparsed; `ssh` defaults to the local user.
- F-20. Relative paths in config resolve against process cwd, unpredictable under Claude Desktop.
- F-21. `finishConnect` does `(manifest as any).manifest = …`, bypassing encapsulation.
- F-22. `doRetryFailed` calls `connections.delete(name)`; a live pool there would leak. Unreachable today due to `retryInFlight`.
- F-23. `remote_stat` output formatting: size and mtime render as 0 while the raw type line carries real values. Observed.

---

## Performance

### P-1. Five TCP connections per target where one suffices
3 command + 2 file clients, each a full handshake and a remote `sshd` process. SSH multiplexes channels over one connection; `ssh2` supports this.
**Evidence:** ~16 `sshd-session` processes observed on genie with two targets pointed at it. On the DS220j each `sshd` costs 10 to 16 MB against ~150 MB free.

### P-2. One SSH exec per path for the jail check
`remoteRealpath` runs `readlink -f` as a full command before every file operation. N-file operations cost N extra round-trips. SFTP has a native `realpath` on the file channel.

### P-3. Application-level pings on every idle client every 30 s
~50 no-op execs/minute across 5 targets, while `keepaliveInterval: 10_000` already detects dead connections at the transport layer.

### P-4. Startup blocks on the full pool
`createSSHPool` awaits both pools. Five sequential handshakes before the first command.

### P-5. Per-chunk `toString` splits multi-byte UTF-8
`stdout += data.toString("utf-8")` decodes each chunk independently; a multi-byte character straddling a chunk boundary is corrupted. Also O(n²) concatenation. Relevant: filenames in the operator's data are predominantly Chinese.

### P-6. Mirror wiped on every connect
`fs.rm(mirrorBase, recursive)` in `finishConnect`. Lazy retries discard the whole local cache.

### P-7. New SFTP session per file operation
`withSftp` opens and closes the SFTP subsystem around each call.

### P-8. Minor
`uname -s` and `git rev-parse` as two execs at connect; per-file SFTP for many-small-file directories (26,000-file case observed) where streamed `tar` would be 5 to 10× faster.

---

## What is done well

- Layering is clean; every tool passes through one gate.
- File-tool jail resolves symlinks via remote realpath before checking, and `forNewFile` resolves the parent. This is the correct approach.
- `retryFailed`: `retryInFlight` collapses concurrent retries; `lastAttempt` set at attempt start prevents a slow connect from triggering another; `finishConnect` clears the failed entry on success. Correct.
- Tests exist for the security-relevant modules plus Docker integration. F-2 is a missing case, not a missing suite.
- `optional` targets, legacy config fallback, and lazy retry form a sane operational model.

---

## Operational note recorded during review

A rebuilt `build/index.js` is not picked up by the running MCP process. Observed: process started 20:37:50, build written 20:46:12, old behaviour persisted until Claude Desktop was fully quit and relaunched. The MCP toggle in Claude Desktop settings did not restart the process.
