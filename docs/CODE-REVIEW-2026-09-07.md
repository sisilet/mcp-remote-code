# Code Review: mcp-remote-code v3.2.0

**Date:** 2026-09-07
**Scope:** all of `src/` (30 files, ~4,600 lines), `test/` (13 files), `README.md`, `README.zh-CN.md`, `package.json`.
**Baseline:** `CODE-REVIEW-2026-09-06.md` reviewed v2.1.0 and `REMEDIATION-PLAN.md` records phases 0 to 5 as applied. This review covers the code as it now stands, after that work.

**Finding numbers continue from the previous review** (which ended at F-23 and P-8) so that references from `REMEDIATION-PLAN.md` stay unambiguous. New findings start at F-24.

**Method:** full read of `ssh-connection.ts`, `root-jail.ts`, `shell-quote.ts`, `tool-utils.ts`, `sync-engine.ts`, `remote-read.ts`, `remote-patch.ts`; three parallel reviews covering the tool layer, the transport and sync layer, and tests plus documentation; every finding below independently verified against the source before being recorded. F-24 was reproduced empirically. `npm test` (77 pass) and `tsc --noEmit` are both green, which is itself part of the finding in F-33.

---

## Summary

The v3.0 refactor was the right call and is well executed. One connection per target with channel concurrency, a persistent SFTP session, and the SFTP-versus-shell namespace probe are all sound, and the comments recording why each past bug happened are unusually good. The defects below are not architectural. Four of them break a guarantee the project documents: one silently does nothing while reporting success, one is a shell injection, one re-executes commands the previous review specifically set out to stop re-executing, and one can destroy a file it was written to protect.

**Provenance**, checked against `HEAD` (`6d91b8e`) rather than assumed, since the working tree is uncommitted:

- **Pre-existing** (present at `6d91b8e`, unchanged): F-24, F-25, F-28, F-29, F-39, F-41, F-42, F-45.
- **Introduced in the current uncommitted work:** F-26, F-27, F-30, F-31, F-32, F-34, F-36, F-37, F-38.

Two of the new ones are incomplete or inverted fixes of items `REMEDIATION-PLAN.md` marks done: F-26 is F-3 (the retry it claims to have disabled), F-27 is F-12 (the truncation it set out to prevent, replaced with total loss).

F-25 is *not* a regression against F-15. F-15 fixed the shared `quoteShell`; `remote-read.ts` has always had its own copy and was never touched by that sweep. It is a miss, not a re-break — which matters for the process question of how to stop it recurring, though not for its severity.

---

## Status

**Fixed 2026-09-07, in this order:** the test fixture first, then F-24, F-25, F-26, F-27.

The fixture came first deliberately. Four criticals had coexisted with a green suite, so fixing them under the same instrument that missed them would have bought nothing. `test/fixtures/fake-ssh-pool.ts` now models a real remote filesystem — files, directories and symlinks, with component-by-component `realpath` — and implements `lstat`, `realpath`, `stat`, `chmod`, `fastPut`, `fastGet`, `unlink` and `rename`, with per-operation fault injection. Two consequences: the SFTP branch of `remoteRealpath`, which is the branch used against every healthy server and which no test had ever executed, is now covered; and the failure paths where F-27 and F-31 to F-34 live are reachable from a test at all. The old no-filesystem behaviour is preserved when `files` is not supplied, so existing tests were not touched.

Two small extractions were needed to make production code reachable rather than re-implementable: the exec retry loop is now `execWithRetry` in `ssh-connection.ts`, and `sftpFastPut` is exported from `sync-engine.ts`. Both are called by the production path, so the tests bind to the real behaviour rather than to a copy of it — the failure mode of the `hotfixes.test.ts` semaphore test noted below.

**Each new test was confirmed to fail against the pre-fix code and pass after**, by reverting each defect individually and re-running:

| Finding | Pre-fix result | Post-fix |
|---|---|---|
| F-24 | 3 failures (`@@ -1,3 +1,4 @@` unparsed, patch applies as no-op) | pass |
| F-25 | 2 failures (`$(touch …)` and `` `id` `` reach the shell unquoted) | pass |
| F-26 | 2 failures (command runs twice; transport still dropped) | pass |
| F-27 | 3 failures (original lost, not restored, mode not preserved) | pass |

Suite is 99 tests, up from 77. `tsc --noEmit` and `lint:stdout` clean.

Notes on the fixes themselves. F-26 separates the two failures the old code conflated: a refused channel is retried up to three times regardless of what the caller asked for, because the command never started, while a mid-command transport death is retried only under an explicit `retry: true`. `onConnectionError` still fires in both cases, since the dead client has to be dropped either way. F-27 moves the target aside instead of unlinking it and only discards the backup once the new content holds the real name, so at every instant either the complete old contents or the complete new contents exist under some name; it also carries the previous file's mode across, which the old version dropped. F-24 additionally raises an error when a file section parses to zero hunks, so that this class of parse failure can never again present as a successful patch.

**Then the symlink cluster, F-28, F-29 and F-30**, fixed together because they are one root cause in three places: a syntactic path check standing in for a resolved one.

- F-28: `jailRemoteDir` is now async and resolves through `resolveUnderRoot`. `remote_glob` and `remote_grep` additionally filter their results, since a search rooted inside the jail can still surface paths outside it.
- F-29: the fix is central rather than per-tool. `resolveUnderRoot`'s `forNewFile` branch resolved the parent and stopped, which is the wrong question when the destination itself already exists as a symlink — parent inside the root, name inside the root, write lands wherever the link points. It now resolves the destination too. That covers `remote_push`, `remote_write` and `remote_patch` in one place. `remote_push` also had its own plain `fastPut`, which is why the F-27 work never reached it; it now uses the shared atomic put, which closes F-12 for push as well.
- F-30: `resolveManyUnderRoot`'s shell batch path defers to the single-path resolver when `forNewFile` is set, rather than maintaining a second script shape that has to get parents right. It costs the round trips the batch saves, on the minority of servers whose SFTP namespace is offset, for the paths where correctness depends on it.

Verified the same way, and additionally in isolation: **each of the three fixes was reverted on its own, and failed exactly its own two tests and nothing else.** That rules out one fix masking another's test.

F-42 (the literal `${plan.type}` in pull and push) was fixed in passing.

Suite is 108 tests. One pre-existing test was updated, `jail-tools.test.ts`, because `jailRemoteDir` is now async.

**Then everything remaining, F-31 to F-45.** All findings in this review are now fixed. Suite is 129 tests, up from 77 at the start of the day; `tsc --noEmit`, `lint:stdout` and `npm run build` are clean, and the built binary reports the right version.

A second fixture was needed for the lifecycle work: `test/fixtures/fake-ssh-client.ts`, a stand-in ssh2 `Client` and channel, injected through a new optional `deps.connect` parameter on `createSSHConnection`. The situations that produced F-31, F-32 and F-34 — a reconnect race, a transport dying with callers queued, a timeout landing before the channel opens — cannot be staged against a real SSH server, which is the reason all three shipped at once.

- **F-31**: reconnect is single-flight. Concurrent callers share one attempt, and a replaced transport is ended rather than stranded. A failed attempt clears the slot so the next call retries.
- **F-32**: queued waiters are now rejected on transport death instead of resolved. Resolving them handed out slots nobody was accounting for, and since running operations return their own slots in `finally`, the count must be left alone.
- **F-34**: a channel that opens after its timeout has fired is killed rather than abandoned.
- **F-35**: `(code, signal)` is honoured everywhere, in the SSH and local paths, via one shared `exitCodeFrom`. A signal kill is no longer exit 0.
- **F-36**: `local-pool.execStream` honours the timeout it accepts and bounds stderr with `BoundedBuffer`.
- **F-37**: bulk pull builds the archive with `tar -h`, so no symlink member exists to extract. This closes the tar-slip without depending on the local tar's behaviour, which differs between bsdtar and GNU tar. The cost, documented in the code, is that a symlinked file arrives as a copy.
- **F-38**: a failed transfer destroys the stream, kills the local tar and waits on the channel only briefly, instead of holding the slot until the 30-minute exec timeout.
- **F-39**: `*** Delete File:` removes the file rather than emptying it, and the summary says which files were deleted.
- **F-40**: the SFTP session is dropped in the same synchronous step as the client, via one `dropTransport`.
- **F-41**: the version is read from `package.json`; verified from the built layout.
- **F-43**: `unhandledRejection` and `uncaughtException` log to stderr and go through the same shutdown path, which is now idempotent and takes an exit code.
- **F-44**: the path-policy rule is written down on `jailRemotePath`, as the one place a new tool will look.
- **F-45**: `PathMapper.isWithinWorkspace` uses `isUnderRoot`, so a root of `/` behaves.

**F-33 is addressed by the above rather than separately.** The modules the review listed as untested — `ssh-connection`, `sync-engine`, `local-pool`, `bulk-transfer`, `path-mapper`, and the unified-diff and quoting paths — now have tests, and the two tests called out as unable to fail were rewritten:

- The `hotfixes.test.ts` channel-slot test no longer reimplements a semaphore. It drives the real connection under repeated channel-open failures. Confirmed by reintroducing the historical double-release: the test fails, where the previous version passed.
- The SFTP branch of `remoteRealpath` is exercised directly, so the symlink cases no longer rely on `isUnderRoot` alone.

Documentation is corrected too: the English README's "no human is prompted" is replaced with what elicitation actually does and when it falls back; the Chinese README is brought to the multi-target model; both note that the local mirror is scratch, deleted on reconnect; `server-instructions.ts` tells the model that a user decline is final; `REMEDIATION-PLAN.md`'s stale "nothing implemented" header is fixed and records that two of its DONE items were later found incomplete; and the v2.1.0 review carries a historical banner.

**Every fix in this document was verified the same way**: the test written first and confirmed failing against the defect, then confirmed passing, and — for the clusters where several fixes touch the same file — each fix reverted individually to confirm it fails only its own tests.

---

## Critical

### F-24. `remote_patch` silently ignores every standard unified diff and reports success — FIXED 2026-09-07
`src/tools/remote-patch.ts:404`. The hunk header regex is missing its commas:

```
/^@@ -(\d+)(?:(\d+))? \+(\d+)(?:(\d+))? @@/
```

`(?:(\d+))?` cannot match `,3`, so after the first number the pattern requires a space and finds a comma.

**Evidence (reproduced):** `@@ -1,3 +1,4 @@` does not match. `@@ -12,7 +12,9 @@ func()` does not match. Only the degenerate `@@ -1 +1 @@` form matches, which is the form git emits solely for single-line hunks.

**Failure mode:** the file is still collected from the `---`/`+++` headers at line 383, `hunks` stays empty, `applyUnifiedDiff` (line 444) iterates zero times and returns the content unchanged, the unchanged content is written back, and line 606 returns `Success. Updated the following files: …`. An agent applying a patch is told it worked and nothing changed. This is the worst possible failure shape: undetectable without reading the file back.

**Fix:** `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`, and raise an error when a parsed file has diff body lines but zero hunks, so this class of parse failure can never again present as success.

### F-25. Shell injection in `remote_read` (missed by the F-15 sweep) — FIXED 2026-09-07
`src/tools/remote-read.ts:228-231` defines a private `quoteShell` that wraps in **double** quotes and escapes only `"`. It does not import `src/shell-quote.ts`. `$(…)`, backticks and backslashes are all interpreted by the remote shell.

Used at lines 35-36, 44-45, 88, 95 and 128, i.e. `file -b`, `dd if=`, the `[ -d ]`/`[ -f ]` type probe, and `ls -1pA`.

**Reachability:** the path is jailed with `allowMissing: true` (line 77), so a path that does not exist still reaches the shell. `filePath` of `$(id)` resolves to `<root>/$(id)`, passes the jail, and is expanded. No pre-existing file is required.

**Why it matters even though `remote_bash` exists:** the file tools are the ones documented as confined to the root. This makes that claim false for `remote_read`, and it is reachable from any path string, including one derived from remote content rather than from the model.

**Fix:** delete the local helper; import the shared `quoteShell` everywhere in this file. Add a lint rule or a test asserting no module defines its own quoting helper.

### F-26. `retry: false` still re-executes the command once (F-3 incomplete) — FIXED 2026-09-07
`src/ssh-connection.ts:201`: `const attempts = options.retry === true ? 3 : 2`.

`remote_bash` passes `retry: false` (`src/tools/remote-bash.ts:136`) precisely so a non-idempotent command is never run twice. But `attempts = 2`, so a connection error on attempt 0 reaches line 226, `isLastAttempt` is false, and the loop `continue`s and re-runs the entire command. `mv`, `rm`, `>>` and every other non-idempotent command are back to the v2.1.0 behaviour.

The reasoning in the comment is correct and the implementation does not match it. A refused channel means the command never started and is always safe to retry; a dropped transport mid-command is not.

**Fix:** `const attempts = options.retry === true ? 3 : 1`, keeping the `isChannelOpenFailure` retry unconditional (it needs its own attempt budget, independent of `options.retry`). Add the test phase 0.3 asked for: a simulated mid-command connection error, assert exactly one execution.

### F-27. The atomic upload can destroy both the old and the new content (F-12 inverted) — FIXED 2026-09-07
`src/sync-engine.ts:128-141`. The sequence is: write temp, `unlink` the target, `rename` temp into place. If the rename fails, the `catch` at line 138 unlinks the temp as well. The original was already deleted, so the file is now gone entirely.

F-12 was raised because a failed `fastPut` leaves a truncated file. Total loss is worse than truncation.

**Fix:** rename the target aside rather than unlinking it, rename the temp into place, then delete the aside copy; restore from the aside copy if the rename fails. Never delete the temp before the final name exists. Where the server supports POSIX-rename (`posix-rename@openssh.com`), use it and skip the dance.

Related: the temp is created by `fastPut` with default permissions, so mode and ownership of the replaced file are not preserved. `fstat` the target first and `fchmod` the temp before renaming.

---

## High

### F-28. `jailRemoteDir` is syntactic only: symlink escape in `remote_glob` and `remote_grep` — FIXED 2026-09-07
`src/tool-utils.ts:90-100` calls `resolveUnderRootSync` and never resolves symlinks, unlike `jailRemotePath` which goes through `resolveUnderRoot`. `remote_glob:28` and `remote_grep:55` then `cd` into that directory. A directory symlink under the root searches outside the jail, and the returned paths are not re-checked with `isUnderRoot`, so the output presents out-of-root results as in-root.

**Fix:** make `jailRemoteDir` async and route it through `resolveUnderRoot`; additionally filter returned result paths through `isUnderRoot`, since a search can surface symlinked entries as well as be rooted at one.

### F-29. `remote_push` writes through symlinks — FIXED 2026-09-07
`src/tools/remote-push.ts:271` calls `sftp.fastPut` directly on a destination resolved with `{ forNewFile: true, allowMissing: true }` (line 62), which validates the parent only. `fastPut` follows symlinks, so a destination that is a symlink to a file outside the root overwrites that file, and a destination directory that is a symlink deposits the whole tree outside the root.

The sync engine's unlink-then-rename happens to avoid this by replacing the link itself; push does not use it.

**Fix:** `lstat` the destination and refuse a symlink, or route push through the same atomic helper as write, edit and patch. The latter also closes the F-12 gap for push, which the remediation plan claims as done.

### F-30. `resolveManyUnderRoot` ignores `forNewFile` in its shell batch path — FIXED 2026-09-07
`src/root-jail.ts:234-259`. The SFTP branch (line 227) delegates to `resolveUnderRoot` and is correct. The shell branch resolves the path itself, never the parent, and with `allowMissing` returns the *syntactic* path from `pre[i]` with no realpath at all.

`remote_patch` calls this with `{ forNewFile: true, allowMissing: true }` (line 563). So on any server where `sftpMatchesShell` is false — the DS220j, whose SFTP namespace is offset, is a live example — patch can create a file through a symlinked parent directory outside the root.

**Fix:** in the batch path, resolve the parent when `forNewFile` is set, or fall back to per-path `resolveUnderRoot` whenever `forNewFile` is set and accept the round trips for that case.

### F-31. Concurrent reconnect opens and leaks multiple SSH clients — FIXED 2026-09-07
`src/ssh-connection.ts:160-166`. `ensureClient` has no single-flight guard. After the transport drops, `client` is undefined and every queued caller passes the `if (client)` check, calls `connect()`, and overwrites the field. Only the last client is retained; the others are never `end()`ed and stay alive as sockets locally and `sshd` processes remotely.

This leaks exactly the resource the v3.0 refactor was written to reclaim, and it is most likely to fire on the NAS, where memory is scarcest.

**Fix:** hold the in-flight connect promise (`let connecting: Promise<Client> | undefined`) and have every caller await the same one; `end()` any client being replaced.

### F-32. `drainWaiters` resets the channel count while operations are still running — FIXED 2026-09-07
`src/ssh-connection.ts:154-157` sets `inFlight = 0` and resolves every waiter. Those waiters resume inside `acquireChannel` believing they hold a slot, and each will later call `releaseChannel`, which decrements from zero (floored at zero by line 127). The count therefore under-reports permanently after a drop, N operations run at once, and new callers pass the fast path freely — the cap that exists to stay under `MaxSessions` is gone until the process restarts.

**Fix:** on transport death, wake waiters to *throw* rather than to inherit a slot, and only reset `inFlight` once in-flight operations have settled.

---

## Medium

### F-33. The test suite would not have caught any of the above — ADDRESSED 2026-09-07
Covered in detail below under "Tests". Recorded here as a finding because four critical defects coexist with a green suite, and three of them are in code paths the remediation plan explicitly promised tests for.

### F-34. Exec timeout before the channel opens leaves the remote command running — FIXED 2026-09-07
`src/ssh-connection.ts:474-507`. The timer is armed before `client.exec`'s callback runs. If it fires first, `activeStream` is still undefined, so the `signal("KILL")` and `close()` are no-ops, the promise rejects, `withChannel` releases the slot, and the remote command runs to completion with nobody watching. F-7 is fixed only for the window after the callback.

**Fix:** arm the timer after the stream exists, or keep the `killed` flag and kill the stream the moment the callback delivers it.

### F-35. Signal-terminated commands are reported as exit 0 — FIXED 2026-09-07
`src/ssh-connection.ts:499` (and the same shape at line 288): ssh2's `close` event is `(code, signal)`, and on signal death `code` is null, so `code ?? 0` reports success. A command killed by `SIGKILL`, including by the timeout path, can be reported as having succeeded.

**Fix:** take both arguments; when `signal` is set, report a failure and name the signal.

### F-36. `local-pool` ignores its timeout and buffers stderr without a cap — FIXED 2026-09-07
`src/local-pool.ts:17-27`. `options.timeout` is accepted and never used, there is no kill path, and stderr is accumulated with plain concatenation while the SSH path uses `BoundedBuffer`. Local targets can hang indefinitely or grow without bound — the two problems F-8 and F-9 addressed for the SSH path.

### F-37. `tar` bulk pull extracts without symlink hardening — FIXED 2026-09-07
`src/bulk-transfer.ts:51`: `tar -xf - -C localDir` with no secure flags. `../` members and absolute names are handled by bsdtar on this host, but symlink members pointing outside the extraction root are the standard tar-slip vector and are unchecked. Bulk pull activates at 50 files.

**Fix:** extract with the secure options for the local tar, or refuse bulk extraction when the available tar cannot enforce them, falling back to per-file.

**On ranking this below the symlink cluster:** agreed on order, but not on the reason. "The remote is already trusted" conflates two different trusts. You trust it to hand you file *contents*; this lets it choose where those files *land on the operator's laptop* — `~/.ssh/authorized_keys`, a shell rc file. Every other data flow in this design is local code deciding what happens on the remote; this is the one place the remote decides what happens locally, and it is the only finding here that reaches outside the remote host at all. It ranks below F-28 to F-30 because it needs a hostile or compromised remote, which is a much stronger precondition than a stray symlink, not because the blast radius is smaller.

### F-38. Bulk transfer failure leaves the SSH channel held — FIXED 2026-09-07
`src/bulk-transfer.ts:56-60, 87-96`. On a pipeline failure the function returns without awaiting `done` or tearing down the stream, so the channel slot is only released when `execStream`'s timeout expires — up to 30 minutes.

### F-39. `*** Delete File:` truncates instead of deleting — FIXED 2026-09-07
`src/tools/remote-patch.ts:651-655` implements delete as `apply: () => ""` followed by a push, so the file remains as an empty file. The move path (line 598) does the `rm -f` correctly, so the machinery exists.

### F-40. Connection-error path clears `client` but not `sharedSftp` — FIXED 2026-09-07
`src/ssh-connection.ts:222-226` nulls `client` synchronously, while `sharedSftp` is cleared only when the `close`/`end` event arrives (line 176). A `withSftp` call in that gap uses a dead session.

---

## Low

- **F-41.** FIXED 2026-09-07. `src/index.ts:24` declares `VERSION = "2.1.0"` while `package.json` is `3.2.0`. This string is served in the MCP initialize payload, `--version` and `--help`. Read it from `package.json` or generate it at build time.
- **F-42 — FIXED 2026-09-07.** `src/tools/remote-pull.ts:116` and `src/tools/remote-push.ts:124` use straight double quotes around `"Pulled remote ${plan.type} successfully."`, so the client is shown the literal text `${plan.type}`.
- **F-43.** FIXED 2026-09-07. No `unhandledRejection` or `uncaughtException` handler in `src/index.ts`. An emitter error without a listener still takes down a long-lived stdio server.
- **F-44.** FIXED 2026-09-07. Path policy differs per tool with no stated rule: read uses `allowMissing` then re-probes, write uses `forNewFile`, edit requires existence, push uses `forNewFile` plus a raw `fastPut`. Worth one documented policy per operation class (read, create, mutate) so a future tool cannot pick the weakest by accident.
- **F-45.** FIXED 2026-09-07. `src/path-mapper.ts:31-36, 85-87` builds `remoteRoot + "/"` without the `/`-root special case that `isUnderRoot` has (the F-2 fix), so with root `/` every workspace path is classified as external.

---

## Tests

`npm test` passes 77 tests and `tsc --noEmit` is clean, and none of F-24 to F-32 is detected. The gaps are specific.

**No dedicated coverage** for 20 of 30 modules, including `shell-quote.ts` — a single test on the shared helper would not have caught F-25, since the bug is a *different* helper, but nothing tests either — plus `ssh-connection.ts`, `sync-engine.ts`, `local-pool.ts`, `bulk-transfer.ts`, `path-mapper.ts`, `bom.ts`, `diff-utils.ts`, and every tool except `remote_bash`.

**Promised and never written.** The remediation plan lists these as the tests for work marked done: non-idempotent command runs exactly once on a connection error (0.3, would have caught F-26), config mode `0600` warning (0.5), `remote_stat` snapshot (0.6), hashed `known_hosts` entries (1.1), `quoteShell` leading `-` (1.5), sudo leading-token-only (1.4), kill SSH mid-command with no re-execution, and a changed-host-key scenario.

**Tests that would survive the regression they describe.**
- `test/hotfixes.test.ts` "channel slots are released exactly once per acquire" reimplements a correct semaphore inside the test file and never imports `ssh-connection`. It asserts that the test's own code is right.
- `test/jail-escapes.test.ts` calls `isUnderRoot` on already-resolved paths, which is the same assertion `root-jail.test.ts` makes. It would pass if `remoteRealpath` stopped resolving symlinks entirely.
- `test/tools/bash.test.ts` never initialises elicitation, so it only exercises the model-acknowledgement fallback and would pass if a user decline stopped being honoured.
- The fake SFTP in `test/fixtures/fake-ssh-pool.ts` implements neither `lstat` nor `realpath`, so every unit test silently exercises the exec fallback and the SFTP resolution path — the default on healthy servers — is untested.

**Docker suite.** Both files register a single empty passing test when `docker info` fails, so a CI machine without Docker is green with zero integration coverage. When it does run it exercises real `ssh2`, SFTP, UTF-8, output caps and the symlink jail, which is valuable — but it connects with `StrictHostKeyChecking=no`, which forces `hostKeyPolicy: insecure`, so host key verification is never tested end to end. It also calls `sshPool.exec` directly rather than the tool handlers, so no tool-level behaviour is covered.

---

## Documentation

- **`README.md:83`** states that `outside`/`force` are model-side only and that "no human is prompted". Elicitation is wired up (`src/index.ts:178`) and does prompt. The Chinese README (`README.zh-CN.md:78-80`) describes the current behaviour correctly; the English one is the stale copy.
- **`src/server-instructions.ts:69-74`** describes the two-step force flow and never mentions elicitation, so the model is not told a human may be asked, nor that the model-side acknowledgement is only a fallback.
- **`REMEDIATION-PLAN.md`** still opens with "proposal, nothing implemented" while phases below it are marked DONE, and decision D-A says "not yet implemented" for work Phase 2 records as complete. Worth one pass to make the status line true.
- **`CODE-REVIEW-2026-09-06.md`** should carry a banner marking it as a point-in-time review of v2.1.0, since several of its findings (F-4, F-5) no longer describe the code.
- **The local mirror is ephemeral** — wiped on every connect (`connection-manager.ts:125-129`) with no freshness validation, by deliberate decision. Neither README says so, and an agent may reasonably treat it as a durable checkout.
- **The Chinese README describes a single-target model** (`README.zh-CN.md:5-12`) while the English one documents multiple targets. The two have drifted in both directions and should be brought into lockstep.

---

## What is done well

- The v3.0 architecture is correct and the measurements backing it are real. Channel concurrency over one transport is how SSH is meant to be used.
- `sftpMatchesShell` is the standout: noticing that a Synology's SFTP namespace is offset from its shell namespace, that `sshd_config` cannot tell you so, and that a security check resolved in the wrong namespace is worse than no check, is a level of care most codebases do not reach.
- The comments record the failure that motivated each piece of code — the slot double-release, the unconsumed-stdout stall, the leaked half-open channel on an SFTP-less server. That is the most valuable documentation in the repository.
- `BoundedBuffer` concatenates before decoding, so multi-byte characters spanning chunks survive.
- `connection-manager.ts` retry coalescing (`retryInFlight`, `lastAttempt` at attempt start) is correct.
- The two documented "WON'T DO" decisions in the remediation plan — the prefix cache and the persistent mirror — are both right, and reasoned from measurement rather than taste.

---

## Suggested order

1. F-24 (patch applies nothing), F-25 (injection), F-26 (re-execution), F-27 (data loss). Each with the regression test that would have caught it.
2. F-28, F-29, F-30: the three symlink escapes. They share a root cause — a syntactic check standing in for a resolved one — and should be fixed as one change with a single shared helper.
3. F-31, F-32: reconnect single-flight and waiter draining.
4. Documentation: the English README elicitation paragraph, server instructions, the version string (F-41).
5. The remaining medium findings, and the promised tests that are still missing.
