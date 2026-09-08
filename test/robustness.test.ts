import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Readable } from "node:stream"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createLocalPool } from "../src/local-pool.ts"
import { abandonTransfer, pullDirectoryViaTar } from "../src/bulk-transfer.ts"
import { parseAndPrepareNative } from "../src/tools/remote-patch.ts"
import { PathMapper } from "../src/path-mapper.ts"

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe("F-36 local target streams are bounded and time out", () => {
  it("honours the timeout it accepts", async () => {
    const pool = createLocalPool()
    const started = Date.now()

    const { done } = await pool.execStream("sleep 30", { timeout: 100 })
    const result = await done

    assert.ok(Date.now() - started < 5_000, "the timeout option must actually fire")
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /timeout/i)
  })

  it("caps stderr instead of buffering without limit", async () => {
    const pool = createLocalPool()

    const { stdout, done } = await pool.execStream(
      `node -e "for (let i = 0; i < 20000; i++) process.stderr.write('x'.repeat(100) + '\\n')"`
    )
    stdout.resume()
    const result = await done

    assert.ok(
      result.stderr.length < 200_000,
      `stderr must be capped, got ${result.stderr.length} bytes`
    )
    assert.match(result.stderr, /truncated/i)
  })

  it("reports a signal-killed local command as a failure", async () => {
    const pool = createLocalPool()
    const { stdout, done } = await pool.execStream("sleep 30", { timeout: 50 })
    stdout.resume()
    assert.notEqual((await done).exitCode, 0)
  })
})

describe("F-37 bulk pull cannot be made to write outside the mirror", () => {
  it("asks the remote tar to dereference, so no symlink member exists", async () => {
    const localDir = await tempDir("mcp-bulk-")
    const sourceDir = await tempDir("mcp-bulk-src-")
    await fs.writeFile(path.join(sourceDir, "a.txt"), "hello")

    let issued = ""
    const fakePool: any = {
      async execStream(command: string) {
        issued = command
        // Stand in for the remote tar with a real local one.
        const child = spawn("tar", ["-cf", "-", "-C", sourceDir, "."])
        return {
          stdout: child.stdout,
          stdin: child.stdin,
          done: new Promise((resolve) =>
            child.on("close", (code) => resolve({ exitCode: code ?? 0, stderr: "" }))
          ),
        }
      },
    }

    const result = await pullDirectoryViaTar(fakePool, "/remote/dir", localDir)

    assert.ok(result.ok, `pull should succeed: ${result.error}`)
    assert.match(
      issued,
      /tar -cf - -h /,
      "the archive must be built with symlinks dereferenced, so no member can point outside the mirror"
    )
    assert.equal(await fs.readFile(path.join(localDir, "a.txt"), "utf-8"), "hello")
  })
})

describe("F-38 a failed transfer releases its channel", () => {
  it("tears down both ends and does not wait on a channel that never closes", async () => {
    let destroyed = false
    let killed: string | undefined
    const stream = Object.assign(new Readable({ read() {} }), {
      destroy() {
        destroyed = true
      },
    })

    const started = Date.now()
    await abandonTransfer({
      stream,
      child: {
        kill(signal?: NodeJS.Signals) {
          killed = signal
          return true
        },
      },
      // The case that motivated the fix: the remote side never finishes.
      done: new Promise(() => {}),
    })

    assert.ok(destroyed, "the stream must be destroyed so the channel can close")
    assert.equal(killed, "SIGKILL", "the local tar must be killed")
    assert.ok(Date.now() - started < 10_000, "teardown must not block on the stalled side")
  })

  it("reports the failure to the caller so it can fall back", async () => {
    const localDir = await tempDir("mcp-bulk-fail-")
    const fakePool: any = {
      async execStream() {
        const failing = new Readable({
          read() {
            this.destroy(new Error("connection reset"))
          },
        })
        return { stdout: failing, stdin: null, done: Promise.resolve({ exitCode: 1, stderr: "" }) }
      },
    }

    const result = await pullDirectoryViaTar(fakePool, "/remote/dir", localDir)

    assert.equal(result.ok, false)
    assert.match(result.error ?? "", /stream failed/)
  })
})

describe("F-39 patch delete removes the file", () => {
  it("marks a native delete hunk for removal rather than emptying it", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "*** End Patch",
    ].join("\n")

    const files = await parseAndPrepareNative(patch, "/home/test/project", undefined)

    assert.equal(files.length, 1)
    assert.equal(files[0].path, "/home/test/project/doomed.txt")
    assert.equal(files[0].remove, true, "a deleted file must be removed, not truncated to empty")
  })

  it("does not mark an update hunk for removal", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: fresh.txt",
      "+hello",
      "*** End Patch",
    ].join("\n")

    const files = await parseAndPrepareNative(patch, "/home/test/project", undefined)
    assert.notEqual(files[0]?.remove, true)
  })
})

describe("F-45 path mapper with a root of /", () => {
  const mapperFor = (remoteRoot: string) =>
    new PathMapper({
      host: "h",
      user: "u",
      port: 22,
      remoteWorkdir: remoteRoot,
      mirrorRoot: path.join(os.tmpdir(), "mcp-remote-code-test-mirrors"),
      extraOptions: [],
    } as any)

  it("treats paths as inside the workspace when the root is /", () => {
    const mapper = mapperFor("/")
    assert.equal(mapper.isWithinWorkspace("/volume1/data"), true)
    assert.equal(mapper.isWithinWorkspace("/"), true)
  })

  it("still distinguishes a sibling prefix", () => {
    const mapper = mapperFor("/media")
    assert.equal(mapper.isWithinWorkspace("/media/x"), true)
    assert.equal(mapper.isWithinWorkspace("/mediax"), false)
  })

  it("maps a path under root / into the mirror without doubling it", () => {
    const mapper = mapperFor("/")
    const local = mapper.toLocal("/etc/hosts")
    assert.ok(local.endsWith(path.join("etc", "hosts")), `unexpected mirror path: ${local}`)
  })
})
