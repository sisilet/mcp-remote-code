import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { execWithRetry } from "../src/ssh-connection.ts"
import { sftpFastPut } from "../src/sync-engine.ts"
import { quoteShell } from "../src/shell-quote.ts"
import { applyUnifiedDiff, detectNoNewlineAtEnd, parseUnifiedPatch } from "../src/tools/remote-patch.ts"
import { createRemoteReadTool } from "../src/tools/remote-read.ts"
import { createRemoteGlobTool } from "../src/tools/remote-glob.ts"
import { createRemoteGrepTool } from "../src/tools/remote-grep.ts"
import { resolveManyUnderRoot, resolveUnderRoot } from "../src/root-jail.ts"
import { jailRemotePath } from "../src/tool-utils.ts"
import { ConnectionManager } from "../src/connection-manager.ts"
import { createFakeSSHPool } from "./fixtures/fake-ssh-pool.ts"
import { createTestConnection } from "./fixtures/test-connection.ts"

const ROOT = "/home/test/project"

const connectionError = () => new Error("read ECONNRESET: connection lost")

// ---------------------------------------------------------------------------
// F-26: retry: false must mean exactly one execution
// ---------------------------------------------------------------------------

describe("F-26 exec retry semantics", () => {
  it("runs a non-idempotent command exactly once when the transport dies", async () => {
    let runs = 0
    await assert.rejects(
      execWithRetry(
        async () => {
          runs++
          throw connectionError()
        },
        { retry: false }
      )
    )
    // remote_bash passes retry: false precisely so a half-executed `mv` or
    // `rm` is never applied twice.
    assert.equal(runs, 1, "connection error must not re-run the command")
  })

  it("still drops the dead transport when it will not retry", async () => {
    let dropped = 0
    await assert.rejects(
      execWithRetry(
        async () => {
          throw connectionError()
        },
        { retry: false, onConnectionError: () => dropped++ }
      )
    )
    assert.equal(dropped, 1, "the dead client must be discarded either way")
  })

  it("retries a connection error when the caller declares the command idempotent", async () => {
    let runs = 0
    await assert.rejects(
      execWithRetry(
        async () => {
          runs++
          throw connectionError()
        },
        { retry: true }
      )
    )
    assert.equal(runs, 3)
  })

  it("succeeds on a later attempt when retry is allowed", async () => {
    let runs = 0
    const result = await execWithRetry(
      async () => {
        runs++
        if (runs < 2) throw connectionError()
        return "ok"
      },
      { retry: true }
    )
    assert.equal(result, "ok")
    assert.equal(runs, 2)
  })

  it("retries a refused channel even when retry is false", async () => {
    // A refused channel means the command never started, so re-running it
    // cannot double-apply anything.
    let runs = 0
    const result = await execWithRetry(
      async () => {
        runs++
        if (runs < 2) throw new Error("Channel open failure: open failed")
        return "ok"
      },
      { retry: false, delay: async () => {} }
    )
    assert.equal(result, "ok")
    assert.equal(runs, 2)
  })

  it("never retries a timeout", async () => {
    let runs = 0
    await assert.rejects(
      execWithRetry(
        async () => {
          runs++
          throw Object.assign(new Error("SSH exec timeout after 1000ms"), { isTimeout: true })
        },
        { retry: true }
      )
    )
    assert.equal(runs, 1)
  })
})

// ---------------------------------------------------------------------------
// F-27: a failed upload must never lose the file it was replacing
// ---------------------------------------------------------------------------

describe("F-27 atomic remote upload", () => {
  const REMOTE = "/home/test/project/app.ts"

  it("preserves the original when the rename fails", async () => {
    const pool = createFakeSSHPool({
      files: { "/home/test/project": { type: "dir" }, [REMOTE]: "original contents" },
      faults: { rename: 2 }, // the move-aside and the move-into-place both fail
    })

    await pool.withSftp(async (sftp) => {
      await assert.rejects(sftpFastPut(sftp, "/local/app.ts", REMOTE))
    })

    assert.equal(
      pool.read(REMOTE),
      "original contents",
      "a failed upload must leave the previous contents in place"
    )
  })

  it("restores the original when the move-into-place fails after the move-aside", async () => {
    const pool = createFakeSSHPool({
      files: { "/home/test/project": { type: "dir" }, [REMOTE]: "original contents" },
      faults: { rename: 0 },
    })

    await pool.withSftp(async (sftp) => {
      // Fail only the second rename: the target has already been moved aside.
      let renames = 0
      const realRename = sftp.rename.bind(sftp)
      sftp.rename = (from: string, to: string, cb: (err?: Error) => void) => {
        renames++
        if (renames === 2) {
          cb(new Error("rename failed"))
          return
        }
        realRename(from, to, cb)
      }
      await assert.rejects(sftpFastPut(sftp, "/local/app.ts", REMOTE))
      sftp.rename = realRename
    })

    assert.equal(pool.read(REMOTE), "original contents", "the original must be put back")
  })

  it("replaces the file and leaves no temp or backup behind on success", async () => {
    const pool = createFakeSSHPool({
      files: { "/home/test/project": { type: "dir" }, [REMOTE]: "original contents" },
    })

    await pool.withSftp((sftp) => sftpFastPut(sftp, "/local/app.ts", REMOTE))

    assert.equal(pool.read(REMOTE), "<uploaded /local/app.ts>")
    const leftovers = pool.paths().filter((p) => p.includes("mcp-tmp-") || p.includes("mcp-bak-"))
    assert.deepEqual(leftovers, [], "no temp or backup files may survive a successful upload")
  })

  it("preserves the mode of the file it replaces", async () => {
    const pool = createFakeSSHPool({
      files: {
        "/home/test/project": { type: "dir" },
        [REMOTE]: { type: "file", content: "#!/bin/sh", mode: 0o755 },
      },
    })

    await pool.withSftp((sftp) => sftpFastPut(sftp, "/local/app.ts", REMOTE))

    const entry = pool.entry(REMOTE)
    assert.equal(entry?.type === "file" ? entry.mode : undefined, 0o755)
  })

  it("writes a new file when there is nothing to replace", async () => {
    const pool = createFakeSSHPool({ files: { "/home/test/project": { type: "dir" } } })

    await pool.withSftp((sftp) => sftpFastPut(sftp, "/local/new.ts", "/home/test/project/new.ts"))

    assert.equal(pool.read("/home/test/project/new.ts"), "<uploaded /local/new.ts>")
  })
})

// ---------------------------------------------------------------------------
// F-24: unified diffs must actually apply, and must never no-op silently
// ---------------------------------------------------------------------------

describe("F-24 unified diff parsing", () => {
  const diff = [
    "--- a/greet.ts",
    "+++ b/greet.ts",
    "@@ -1,3 +1,4 @@",
    " export function greet(name: string) {",
    '-  return "hi " + name',
    '+  return `hello ${name}`',
    "+  // changed",
    " }",
    "",
  ].join("\n")

  it("parses a standard multi-line hunk header", () => {
    const files = parseUnifiedPatch(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].hunks.length, 1, "@@ -1,3 +1,4 @@ must parse")
    assert.equal(files[0].hunks[0].oldStart, 1)
    assert.equal(files[0].hunks[0].oldCount, 3)
    assert.equal(files[0].hunks[0].newCount, 4)
  })

  it("parses a hunk header carrying a trailing section heading", () => {
    const files = parseUnifiedPatch(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -12,7 +12,9 @@ function outer() {", " a", "+b", ""].join("\n")
    )
    assert.equal(files[0].hunks.length, 1)
    assert.equal(files[0].hunks[0].oldStart, 12)
  })

  it("still parses the single-line form without counts", () => {
    const files = parseUnifiedPatch(["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"))
    assert.equal(files[0].hunks.length, 1)
    assert.equal(files[0].hunks[0].oldCount, 1)
  })

  it("changes the content it claims to change", () => {
    const original = ['export function greet(name: string) {', '  return "hi " + name', "}", ""].join("\n")
    const files = parseUnifiedPatch(diff)
    const result = applyUnifiedDiff(original, files[0].hunks, detectNoNewlineAtEnd(files[0].hunks))
    assert.notEqual(result, original, "a patch that reports success must not be a no-op")
    assert.match(result, /hello \$\{name\}/)
    assert.match(result, /\/\/ changed/)
    assert.doesNotMatch(result, /"hi " \+ name/)
  })
})

// ---------------------------------------------------------------------------
// F-25: every remote command must be built with the shared quoting helper
// ---------------------------------------------------------------------------

describe("F-25 remote_read shell quoting", () => {
  /**
   * Positions where `needle` appears outside single quotes, i.e. where the
   * shell would actually interpret it. Inside single quotes nothing is
   * special, so the marker appearing there is exactly what safe quoting
   * looks like.
   */
  function unquotedOccurrences(command: string, needle: string): number[] {
    const hits: number[] = []
    let inQuotes = false
    for (let i = 0; i < command.length; i++) {
      if (command[i] === "'") {
        inQuotes = !inQuotes
        continue
      }
      if (!inQuotes && command.startsWith(needle, i)) hits.push(i)
    }
    return hits
  }

  async function runRemoteRead(filePath: string) {
    const pool = createFakeSSHPool({
      exec: async () => ({ stdout: "MISSING", stderr: "", exitCode: 0 }),
    })
    const conn = await createTestConnection(pool, ROOT)
    const manager = new ConnectionManager()
    manager.setConnectionForTest(conn)

    let handler: ((args: any) => Promise<any>) | undefined
    const server = {
      registerTool: (_name: string, _def: unknown, fn: (args: any) => Promise<any>) => {
        handler = fn
      },
    }
    createRemoteReadTool(server as any, manager)
    assert.ok(handler, "remote_read must register a handler")
    await handler!({ filePath })
    return pool.calls.map((c) => c.command)
  }

  it("does not let command substitution reach the remote shell", async () => {
    const commands = await runRemoteRead("$(touch /tmp/pwned).txt")
    assert.ok(commands.length > 0, "the tool must have issued at least one command")
    for (const command of commands) {
      assert.deepEqual(
        unquotedOccurrences(command, "$(touch"),
        [],
        `command substitution left interpretable by the shell: ${command}`
      )
    }
  })

  it("quotes backticks and metacharacters", async () => {
    const commands = await runRemoteRead("`id`.txt")
    for (const command of commands) {
      assert.deepEqual(
        unquotedOccurrences(command, "`id`"),
        [],
        `backtick substitution left interpretable by the shell: ${command}`
      )
    }
  })

  it("the assertion itself catches the pre-fix quoting", () => {
    // Guards the guard: the double-quote helper this replaced produced
    // exactly this shape, and the scan above must reject it.
    const oldStyle = `file -b "/home/test/project/$(touch /tmp/pwned).txt"`
    assert.notDeepEqual(unquotedOccurrences(oldStyle, "$(touch"), [])
  })

  it("uses the shared helper, which single-quotes anything unsafe", () => {
    assert.equal(quoteShell("$(id)"), "'$(id)'")
    assert.equal(quoteShell("--rf"), "'--rf'")
    assert.equal(quoteShell("plain.txt"), "plain.txt")
    assert.equal(quoteShell("it's"), `'it'"'"'s'`)
  })
})

// ---------------------------------------------------------------------------
// F-28 / F-29 / F-30: the symlink escapes. One root cause in three places —
// a syntactic path check standing in for a resolved one.
// ---------------------------------------------------------------------------

/** Register a tool against a stub server and return its handler. */
async function toolHandler(
  create: (server: any, manager: ConnectionManager) => void,
  conn: Awaited<ReturnType<typeof createTestConnection>>
) {
  const manager = new ConnectionManager()
  manager.setConnectionForTest(conn)
  let handler: ((args: any) => Promise<any>) | undefined
  create({ registerTool: (_n: string, _d: unknown, fn: any) => { handler = fn } }, manager)
  assert.ok(handler, "the tool must register a handler")
  return handler!
}

const textOf = (result: any): string => result.content[0].text as string

/** Root containing a directory symlink that points outside it. */
function poolWithEscapingDirLink() {
  return createFakeSSHPool({
    cwd: ROOT,
    files: {
      [ROOT]: { type: "dir" },
      [`${ROOT}/inside`]: { type: "dir" },
      "/home/test/secret": { type: "dir" },
      "/home/test/secret/keys.txt": "secret",
      [`${ROOT}/link`]: { type: "symlink", target: "/home/test/secret" },
    },
  })
}

describe("F-28 glob and grep search directory", () => {
  it("remote_glob refuses a search directory that is a symlink out of the root", async () => {
    const pool = poolWithEscapingDirLink()
    const conn = await createTestConnection(pool, ROOT)
    const handler = await toolHandler(createRemoteGlobTool, conn)

    const result = await handler({ pattern: "*.txt", path: "link" })

    assert.match(textOf(result), /outside the allowed root|resolves outside/)
    assert.ok(
      !pool.calls.some((c) => c.command.includes("rg --files")),
      "no search may run against a directory outside the root"
    )
  })

  it("remote_grep refuses a search directory that is a symlink out of the root", async () => {
    const pool = poolWithEscapingDirLink()
    const conn = await createTestConnection(pool, ROOT)
    const handler = await toolHandler(createRemoteGrepTool, conn)

    const result = await handler({ pattern: "token", path: "link" })

    assert.match(textOf(result), /outside the allowed root|resolves outside/)
    assert.ok(
      !pool.calls.some((c) => c.command.includes("rg --json") || c.command.includes("grep -Ern")),
      "no search may run against a directory outside the root"
    )
  })

  it("still searches a normal directory inside the root", async () => {
    const pool = poolWithEscapingDirLink()
    const conn = await createTestConnection(pool, ROOT)
    const handler = await toolHandler(createRemoteGlobTool, conn)

    const result = await handler({ pattern: "*.txt", path: "inside" })

    assert.doesNotMatch(textOf(result), /outside the allowed root/)
    assert.ok(pool.calls.some((c) => c.command.includes(`cd ${ROOT}/inside`)))
  })
})

describe("F-29 destination that is itself a symlink out of the root", () => {
  it("refuses a new-file destination pointing outside the root", async () => {
    const pool = createFakeSSHPool({
      cwd: ROOT,
      files: {
        [ROOT]: { type: "dir" },
        "/home/test/secret": { type: "dir" },
        "/home/test/secret/keys.txt": "secret",
        [`${ROOT}/innocent.txt`]: { type: "symlink", target: "/home/test/secret/keys.txt" },
      },
    })
    const conn = await createTestConnection(pool, ROOT)

    // The path remote_push, remote_write and remote_patch all resolve with.
    const result = await jailRemotePath(conn, "innocent.txt", {
      forNewFile: true,
      allowMissing: true,
    })

    assert.ok("errorText" in result, "writing through a symlink out of the root must be refused")
  })

  it("refuses a destination directory that is a symlink out of the root", async () => {
    const pool = poolWithEscapingDirLink()
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "link", { forNewFile: true, allowMissing: true })

    assert.ok("errorText" in result)
  })

  it("still allows creating a genuinely new file inside the root", async () => {
    const pool = createFakeSSHPool({ cwd: ROOT, files: { [ROOT]: { type: "dir" } } })
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "new.txt", { forNewFile: true, allowMissing: true })

    assert.equal("path" in result ? result.path : undefined, `${ROOT}/new.txt`)
  })

  it("still allows overwriting an ordinary existing file inside the root", async () => {
    const pool = createFakeSSHPool({
      cwd: ROOT,
      files: { [ROOT]: { type: "dir" }, [`${ROOT}/app.ts`]: "content" },
    })
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "app.ts", { forNewFile: true, allowMissing: true })

    assert.equal("path" in result ? result.path : undefined, `${ROOT}/app.ts`)
  })
})

describe("F-30 batch resolution where SFTP is offset from the shell", () => {
  // sftpCwd differs from cwd, so sftpMatchesShell is false and
  // resolveManyUnderRoot takes its shell batch path. This is the DS220j.
  function offsetPool() {
    return createFakeSSHPool({
      cwd: ROOT,
      sftpCwd: "/offset/project",
      files: {
        [ROOT]: { type: "dir" },
        "/home/test/secret": { type: "dir" },
        [`${ROOT}/link`]: { type: "symlink", target: "/home/test/secret" },
      },
    })
  }

  it("refuses a new file under a parent that is a symlink out of the root", async () => {
    const pool = offsetPool()

    const results = await resolveManyUnderRoot(
      ROOT,
      ["link/planted.txt", "ordinary.txt"],
      pool,
      { forNewFile: true, allowMissing: true }
    )

    assert.ok(results[0].error, "a parent symlink out of the root must be refused in the batch path")
    assert.equal(results[1].path, `${ROOT}/ordinary.txt`, "ordinary new files still resolve")
  })

  it("agrees with the single-path resolver", async () => {
    const pool = offsetPool()
    const [batch] = await resolveManyUnderRoot(ROOT, ["link/planted.txt", "x.txt"], pool, {
      forNewFile: true,
      allowMissing: true,
    })
    const single = await resolveUnderRoot(ROOT, "link/planted.txt", pool, {
      forNewFile: true,
      allowMissing: true,
    })
    assert.equal(Boolean(batch.error), Boolean(single.error), "batch and single must not disagree")
  })
})

// ---------------------------------------------------------------------------
// The SFTP resolution branch, which no test previously executed
// ---------------------------------------------------------------------------

describe("jail resolution over SFTP", () => {
  it("refuses a symlink that points outside the root, resolved via SFTP", async () => {
    const pool = createFakeSSHPool({
      cwd: ROOT,
      files: {
        [ROOT]: { type: "dir" },
        "/home/test/secret": { type: "dir" },
        "/home/test/secret/keys.txt": "secret",
        [`${ROOT}/escape.txt`]: { type: "symlink", target: "/home/test/secret/keys.txt" },
      },
    })
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "escape.txt")
    assert.ok("errorText" in result, "a symlink out of the root must be refused")
    assert.match(result.errorText, /outside the allowed root/)
  })

  it("refuses a file reached through a directory symlink", async () => {
    const pool = createFakeSSHPool({
      cwd: ROOT,
      files: {
        [ROOT]: { type: "dir" },
        "/home/test/secret": { type: "dir" },
        "/home/test/secret/keys.txt": "secret",
        [`${ROOT}/link`]: { type: "symlink", target: "/home/test/secret" },
      },
    })
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "link/keys.txt")
    assert.ok("errorText" in result, "a directory symlink out of the root must be refused")
  })

  it("allows a normal file inside the root", async () => {
    const pool = createFakeSSHPool({
      cwd: ROOT,
      files: { [ROOT]: { type: "dir" }, [`${ROOT}/app.ts`]: "content" },
    })
    const conn = await createTestConnection(pool, ROOT)

    const result = await jailRemotePath(conn, "app.ts")
    assert.equal("path" in result ? result.path : undefined, `${ROOT}/app.ts`)
  })
})
