# mcp-remote-code: Remediation and Performance Plan

**From:** code review of v2.1.0, 2026-09-06. Full findings with evidence: `CODE-REVIEW-2026-09-06.md` (F-n = findings, P-n = performance).
**Status (updated 2026-09-07):** phases 0 to 5 are implemented, with the exceptions noted in place (3.3 and 2.5 are WON'T DO, with reasons). The per-phase "DONE" markers below are accurate; the line that used to say "nothing implemented" was left over from the first draft.

**Two items recorded here as done were later found incomplete**, in the 2026-09-07 review: phase 0.3 (retry) as F-26, and phase 4.2 (atomic writes) as F-27 and, for `remote_push`, F-29. Both are now fixed with regression tests. Treat `CODE-REVIEW-2026-09-07.md` as the current statement of what is true.
**Principle:** ship the small correctness fixes first, alone, so their effect is measurable. Then security. Then the connection refactor as one coherent change. Never mix a refactor with a hotfix.

Effort key: S = under an hour, M = half a day, L = a day or more.

---

## Phase 0: Hotfixes (v2.1.1) — DONE 2026-09-06

Small, isolated, no design change. One PR, one rebuild, one restart. If the intermittent client hangs stop after this, we know why.

| # | Change | File | Effort | Test |
|---|---|---|---|---|
| 0.1 (F-1) | `console.log` → `console.error` (stdout is the MCP channel) | `ssh-pool.ts:147,342` | S | lint rule: forbid `console.log` outside `index.ts` help/version paths |
| 0.2 (F-2) | Fix `isUnderRoot` for root `/` | `root-jail.ts:13` | S | add cases: root `/` with `/volume1`, `/a` vs `/ab` (prefix trap), trailing-slash root |
| 0.3 (F-3) | Disable exec retry for `remote_bash`; make retry opt-in (`{ retry: true }`) for internal probes only | `ssh-pool.ts` `execOnPool`, `remote-bash.ts` | S | unit: non-idempotent command runs exactly once on simulated connection error |
| 0.4 (F-8, P-5) | Decode output once: collect `Buffer[]`, `Buffer.concat`, decode; cap at N MB and stop reading | `ssh-pool.ts` `execOnClient` | S | unit: multi-byte char split across chunks decodes correctly; oversize output truncated with marker |
| 0.5 (F-11) | Warn (or refuse) if `targets.json` mode is wider than `0600` when `password`/`sudoPassword` present | `config.ts` `loadTargetsConfigFile` | S | unit with temp file modes |
| 0.6 (F-23) | `remote_stat` field formatting | `remote-stat.ts` | S | snapshot test |

**Acceptance:** all 5 targets connect; `nas` (root `/`) can `remote_read` a file; run a 5-minute `remote_bash` with a health check firing mid-way and confirm the client does not hang.

**Version:** 2.1.1 — built and verified. 54 tests pass (6 added: root-jail edge cases, UTF-8 chunk split, output cap). Not yet activated: requires a full Claude Desktop quit+relaunch to load the new build.

Applied: 0.1 (2 console.log→console.error in ssh-pool), 0.2 (isUnderRoot root "/" + prefix-trap, with tests), 0.3 (retry now opt-in; 21 internal idempotent probes opted in, remote_bash explicitly retry:false), 0.4 (BoundedBuffer: chunks collected and decoded once, 4MB cap; applied to both ssh-pool and local-pool), 0.5 (stderr warning when a secret-bearing config is looser than 0600), 0.6 (remote_stat emitted literal \t in stat -c so fields never split; now printf-joined — this was the size/mtime=0 bug).

---

## Phase 1: Security (v2.2.0) — DONE 2026-09-06

| # | Change | File | Effort | Notes |
|---|---|---|---|---|
| 1.1 (F-4) | Host key verification: `hostVerifier` that checks `~/.ssh/known_hosts` (all key types, hashed entries too); optional `hostKeyFingerprint` pin per target | `ssh-pool.ts`, `config.ts` | M | Unknown host: fail with the fingerprint and a one-line instruction to add it. Never auto-accept. `StrictHostKeyChecking=no` becomes an explicit, logged opt-out. |
| 1.2 (F-5) | Confirmation honesty. Two options; pick one: (a) wire to MCP elicitation so a human answers, or (b) keep the model-side speed bump but rename in tool descriptions and README to "model acknowledgement", not "confirmation" | `confirmation.ts`, `server-instructions.ts`, `README*` | (a) M, (b) S | (a) is the only version that protects against a model that decides to proceed. |
| 1.3 (F-6) | `remote_bash` jail honesty: tool description and README state that only `cwd` is constrained; the command may reference any path | `remote-bash.ts`, `README*` | S | Design is fine; the claim isn't. |
| 1.4 (F-10) | `sudo`: prefer documenting NOPASSWD sudoers for the tool user; if `sudoPassword` stays, apply only to a leading `sudo` token, never regex-replace inside the command | `ssh-pool.ts` `exec` | S | Current `\bsudo\b` replace mutates command text. |
| 1.5 (F-15) | `quoteShell`: always quote, or exclude a leading `-` from passthrough | `shell-quote.ts` | S | prevents argument injection into downstream commands |

**Acceptance:** met. 61 tests pass (7 added for host key verification: unknown host, match, mismatch, `[host]:port`, missing file). README has a Security model section stating plainly that `remote_bash` is not sandboxed. Pre-flight: all four SSH targets have recorded keys and will pass the new strict default.

Applied: 1.1 new `src/known-hosts.ts` using `ssh-keygen -F` (handles hashed entries, `[host]:port`, `@cert-authority`/`@revoked` markers) wired to ssh2's `hostVerifier`, with `hostKeyPolicy` per target (`verify` default / `accept-new` / `insecure`) and a stashed error so a mismatch reports the fingerprint and the `ssh-keygen -R` command instead of ssh2's generic handshake failure; 1.2 confirmation re-worded as a model-side acknowledgement (option b: no MCP elicitation yet); 1.3 `remote_bash` description states only `cwd` is constrained; 1.4 sudo rewrite restricted to a leading `sudo` token; 1.5 `quoteShell` always quotes a leading `-`.

**Deferred from 1.2:** wiring confirmation to MCP elicitation so a human answers. Still the only version that constrains a model that decides to proceed.

---

## Phase 2: Connection architecture (v3.0.0) — DONE 2026-09-06

One coherent refactor of `ssh-pool.ts`. Behaviour change justifies a major version: `REMOTE_POOL_*` env vars change meaning.

| # | Change | Effort | Rationale |
|---|---|---|---|
| 2.1 (P-1) | **One `Client` per target, concurrency via channels.** Keep a second connection only as failover. | L | 5 handshakes → 1; 5 remote `sshd` processes → 1 (10 to 16 MB each on the NAS). Observed ~16 `sshd-session` on genie from two targets. |
| 2.2 (P-4) | **Lazy readiness**: target usable after the first channel opens; do not block on a full pool | S (after 2.1) | Startup latency, and slow `optional` targets stop delaying the rest |
| 2.3 (P-3) | **Drop the exec-based ping loop**; rely on `keepaliveInterval` (already set) plus lazy validation on acquire after idle > 60 s | S | ~50 no-op execs/min across 5 targets today |
| 2.4 (P-7) | **Persistent SFTP session per client**, opened lazily, reused | S | one subsystem handshake per file op today |
| 2.5 (P-6) | **Keep the mirror across reconnects**; validate via manifest hashes instead of `fs.rm` on connect | M | lazy retries currently discard the whole cache |
| 2.6 (F-9) | `acquire()` timeout; exec timeout measured from call, not from acquire | S | unbounded waits are a hang source |
| 2.7 (F-14) | Health-check re-entrancy guard | S | same pattern as `replenishing` |
| 2.8 (P-8) | Combine `uname -s` and `git rev-parse` into one exec at connect | S | |

**Acceptance:** met. A/B measured against real targets: genie connect 462→116 ms, NAS 3597→400 ms; 12 concurrent execs pass on both; `src/ssh-pool.ts` shrank 704→174 lines (530 net deleted, the replenisher, ping loop, busy set and wait queue all gone). 70 tests pass, smoke green.

**Two real bugs found by the A/B harness, neither visible in unit tests:**
1. *Channel exhaustion.* 12 concurrent execs hit OpenSSH `MaxSessions` (10, and SFTP counts too) → "Channel open failure". Fixed: default cap 6, and channel-open failures are retried since a refused channel means the command never started.
2. *Unconsumed stdout stalls the channel.* `execStream` callers that only write (a tar push) never read stdout; the window fills, the remote blocks, the channel never closes. The files transferred correctly and then the call hung forever. Fixed by draining stdout unless the caller takes it, via a getter that detects consumption.

Deferred to Phase 3: 2.4 persistent SFTP session, 2.5 keep mirror across reconnects.

---

## Phase 3: Path resolution (v3.1.0) — 3.1 and 2.4 DONE 2026-09-06

| # | Change | Effort | Notes |
|---|---|---|---|
| 3.1 (P-2) | Jail check via SFTP `realpath` on the persistent SFTP channel instead of `exec readlink -f` | M | removes one round-trip from every file tool |
| 3.2 | Batch resolution for multi-file tools (`remote_pull`, `remote_glob` results) | M | N round-trips → 1 |
| 3.3 | Session cache of resolved directory prefixes, invalidated on write/rename under that prefix | M | optional; measure after 3.1 and 3.2 first |

**Acceptance (3.1, 2.4):** met. Jail resolution 873 ms → 263 ms for 30 paths (3.3x). Path resolution alone: genie 2.3x faster, NAS 1.2x. 73 tests pass, smoke green.

**Security verified before shipping**, against a real fixture on genie: absolute symlink escape, relative symlink escape, directory-symlink escape, plain `..` traversal, absolute path outside root, and a missing path — all six refused, normal file allowed. SFTP `realpath` fully resolves symlinks including relative and directory links, so the jail still sees the true target. `test/jail-escapes.test.ts` keeps the resolved-path cases as a regression.

**Three real bugs found while doing this, all invisible to unit tests:**
1. *SFTP realpath does not fail for a missing path* — it returns the path unchanged, where the old exec version signalled absence. Callers rely on null meaning "not found", so existence is now checked with `lstat` first. Using realpath alone would have made every missing path look present.
2. *Unhandled `error` events are fatal.* An SFTP session is an EventEmitter; without a listener a channel error is an uncaught exception that kills the process rather than rejecting the call.
3. *The DS220j has no SFTP subsystem* (DSM ships it off). Every file operation opened a session, failed with "Unable to start subsystem: sftp", fell back to the shell, and **leaked a half-open channel**, exhausting MaxSessions after ~10 operations and killing the connection. Now detected once, warned about clearly, and the shell fallback is used from then on without retrying.

**3.2 batched resolution — DONE.** `resolveManyUnderRoot` collapses N
resolutions into one operation: pipelined through the shared SFTP session
where usable, or a single shell invocation where not. Wired into
`remote_patch`, which previously resolved every involved path sequentially.
Measured on 12 paths: 1320 ms → 281 ms on a LAN host (4.7x), 1209 ms → 76 ms
on the NAS (16x). Escapes still refused.

**3.3 prefix cache — WON'T DO.** The plan said "measure after 3.1 and 3.2
first", and having measured, it is not justified. 3.1 and 3.2 already deliver
3.8x to 16x; a cache would add a few percent on top. Against that, it would be
caching *security decisions*: a resolved path stays valid only until anything
under that prefix is created, moved, or symlinked, so correctness would depend
on invalidating on every write, rename and delete across every tool. A missed
invalidation is not a stale read, it is a jail escape. Not a good trade for
a few percent.

**2.5 (keep the mirror across reconnects) — WON'T DO as specified.** The plan
said "validate via manifest hashes". There are no hashes: the manifest is only
`Record<remotePath, localRelPath>`, and `sync-engine.ts` performs no freshness
check of any kind. The wipe on connect is therefore the *only* thing preventing
a stale cached file being served as current. Making the mirror persistent
safely first requires recording size and mtime (or a hash) per file and
validating on read, which is a larger change with a correctness risk that
outweighs the benefit: reconnects are now rare, since the connection is
long-lived and retry only fires on failure. Revisit only alongside proper
freshness tracking.

---

## Phase 4: Robustness — DONE 2026-09-06 (shipped in v2.3.0)

| # | Change | File | Effort |
|---|---|---|---|
| 4.1 (F-7) | On exec timeout: close the channel and signal the remote process; evict client if it does not close | `ssh-pool.ts` | S |
| 4.2 (F-12) | Atomic remote writes: write `path.tmp`, `mv` over; same for patch and push | `remote-write.ts`, `remote-patch.ts`, `remote-push.ts`, `sync-engine.ts` | M |
| 4.3 (F-17) | `remote_bash`: report the real exit code; drop the "stderr contains 'permission denied' means failure" heuristic | `remote-bash.ts` | S |
| 4.4 (F-16) | Validate `REMOTE_POOL_*` env: finite, > 0, sane upper bound | `ssh-pool.ts` | S |
| 4.5 (P-8) | Bulk transfer via streamed `tar` over an exec channel for directories with many small files | `remote-pull.ts`, `remote-push.ts` | M |

---

## Phase 5: Config model — PARTIALLY DONE 2026-09-06 (5.3, 5.4, 5.5, 5.6 in v2.3.0; 5.1/5.2 fold into Phase 2)

| # | Change | Effort |
|---|---|---|
| 5.1 (F-13) | Make the structured form (`host`, `user`, `port`, `key`) canonical `RemoteConfig`; treat the `ssh …` string strictly as an input format parsed once | M |
| 5.2 (F-13) | Never build unquoted shell strings from paths (`withIdentity`, `buildSshCommand`); with 5.1 this code goes away | S |
| 5.3 (F-18) | `passphrase` field for encrypted keys, or agent support via `SSH_AUTH_SOCK` | S |
| 5.4 (F-20) | Relative paths in config resolve against the config file's directory, not process cwd | S |
| 5.5 (F-19) | Default user: local username, matching `ssh`, not `root` | S |
| 5.6 (F-21, F-22) | `manifest.reset()` method; remove the `(manifest as any)` cast | S |

---

## Testing plan

- **Unit** (existing suites extended): root-jail edge cases (0.2), retry semantics (0.3), UTF-8 chunk splitting (0.4), config file modes (0.5), known_hosts parsing (1.1), timeout behaviour (4.1).
- **Docker integration** (existing `test/docker`): add a scenario that kills the SSH server mid-command and asserts no re-execution; add a changed-host-key scenario.
- **Manual acceptance per phase**, against the real five targets, recorded in this document.
- **Lint**: forbid `console.log` in `src/` except the help/version paths.

---

## Decisions taken 2026-09-06

- **D-A** Phase 2 will be the real refactor (one connection, many channels), v3.0.0. Best practice: SSH multiplexes channels by design; a connection pool is a database pattern misapplied. Env vars renamed to `REMOTE_MAX_CHANNELS` rather than silently repurposed. **Not yet implemented.**
- **D-B** Elicitation implemented with a config switch (`"elicitation": "off"` per target, or `MCP_ELICITATION=off`). Fails closed: an unsupported client, a decline, or an error all refuse. Falls back to the model-side acknowledgement only when unsupported or disabled, and says so.
- **D-C** `user` is now **mandatory**. There is no default. A config file should state who it connects as; defaulting to `root` meant a typo silently escalated.
- **D-D** `tar` streaming implemented behind `BULK_FILE_THRESHOLD` (50 files) with per-file fallback on any failure. Measured: 300 files pulled from genie in 142ms, UTF-8 intact.

## Verification harness

`scripts/smoke.mjs` connects to the real configured targets **without Claude Desktop** and checks connect, exec, UTF-8 integrity, jail-in and jail-out per target. Run after every build touching connection handling. Optional targets may fail without failing the run. A rollback copy of the last good build is kept at `/tmp/mcp-build-rollback`.

## Rollout

Each phase: `npm run build` → run tests → fully quit and relaunch Claude Desktop (the running process does not pick up a rebuild; observed today: process 20:37, build 20:46, old code still running) → verify all targets.

Suggested cadence: Phase 0 today. Phase 1 this week. Phase 2 as a dedicated block; it's the one that needs uninterrupted time. Phases 3 to 5 as time allows, in order.

---

## Not in scope

- A real sandbox for `remote_bash`. Out of reach without container or seccomp on the remote; the honest fix is documentation (1.3).
- Windows remote support beyond what exists.
