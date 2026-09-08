import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SyncEngine } from "../src/sync-engine.js"

/**
 * Regression tests for the 2026-09-08 stale-mirror overwrite.
 *
 * remote_write used to call pushAll() after writing one file. pushAll uploads
 * the local mirror's copy of EVERY tracked file. For a NEW file the mirror was
 * not refreshed from the remote first, so every earlier file was overwritten
 * with whatever the mirror last held, silently destroying edits made on the
 * remote outside this tool. Tools now push only what they changed, and the
 * engine refuses to push over a remote file that changed since it was pulled.
 */

/** In-memory "remote": path -> { mtime, size, content }. */
function fakeRemote(initial: Record<string, string>) {
  const files = new Map<string, { mtime: number; size: number; content: string }>()
  let clock = 1000
  const put = (p: string, content: string) => files.set(p, { mtime: ++clock, size: content.length, content })
  for (const [p, c] of Object.entries(initial)) put(p, c)
  const uploaded: string[] = []
  const sftp = {
    stat: (p: string, cb: (e?: Error, s?: any) => void) => {
      const f = files.get(p)
      f ? cb(undefined, { mtime: f.mtime, size: f.size, mode: 0o644 }) : cb(new Error("No such file"))
    },
    fastGet: (rp: string, lp: string, cb: (e?: Error) => void) => {
      const f = files.get(rp)
      if (!f) return cb(new Error("No such file"))
      fs.mkdir(path.dirname(lp), { recursive: true }).then(() => fs.writeFile(lp, f.content)).then(() => cb(), cb)
    },
    fastPut: (lp: string, rp: string, cb: (e?: Error) => void) => {
      uploaded.push(rp)
      fs.readFile(lp, "utf-8").then((c) => { put(rp, c); cb() }, cb)
    },
    chmod: (_r: string, _m: number, cb: (e?: Error) => void) => cb(),
    rename: (a: string, b: string, cb: (e?: Error) => void) => {
      const f = files.get(a); if (!f) return cb(new Error("No such file"))
      files.delete(a); files.set(b, f); cb()
    },
    unlink: (r: string, cb: (e?: Error) => void) => { files.delete(r); cb() },
  }
  return { files, sftp, uploaded, touch: (p: string, c: string) => put(p, c) }
}

async function engineWith(remote: ReturnType<typeof fakeRemote>) {
  const mirror = await fs.mkdtemp(path.join(os.tmpdir(), "sync-engine-test-"))
  const pulled: Record<string, string> = {}
  const tracked = new Set<string>()
  const manifest: any = {
    remotePaths: () => [...tracked],
    register: (p: string) => { tracked.add(p); return p },
    save: async () => {},
    setPulled: (p: string, s: string) => { pulled[p] = s },
    getPulled: (p: string) => pulled[p],
  }
  const pathMapper: any = { toLocal: (p: string) => path.join(mirror, p) }
  const sshPool: any = {
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    withSftp: async (fn: (s: any) => Promise<void>) => fn(remote.sftp),
  }
  const engine = new SyncEngine({} as any, pathMapper, manifest, sshPool)
  const writeLocal = async (p: string, c: string) => {
    await fs.mkdir(path.dirname(pathMapper.toLocal(p)), { recursive: true })
    await fs.writeFile(pathMapper.toLocal(p), c)
  }
  return { engine, manifest, pulled, writeLocal }
}

describe("SyncEngine.push guard", () => {
  it("pushes only the given file, never other tracked files", async () => {
    const remote = fakeRemote({ "/r/a.py": "A", "/r/b.py": "B" })
    const { engine, manifest, writeLocal } = await engineWith(remote)
    manifest.register("/r/a.py"); manifest.register("/r/b.py"); manifest.register("/r/c.py")
    await engine.pull(["/r/a.py", "/r/b.py"])
    await writeLocal("/r/c.py", "C")
    await engine.push(["/r/c.py"])
    assert.deepEqual(remote.uploaded.map((u) => u.replace(/\.mcp-tmp-.*$/, "")), ["/r/.c.py"])
    assert.equal(remote.files.get("/r/a.py")!.content, "A", "a.py must be untouched")
  })

  it("push after pull succeeds and records the new stamp", async () => {
    const remote = fakeRemote({ "/r/a.py": "A" })
    const { engine, manifest, pulled, writeLocal } = await engineWith(remote)
    manifest.register("/r/a.py")
    await engine.pull(["/r/a.py"])
    await writeLocal("/r/a.py", "A2")
    await engine.push(["/r/a.py"])
    assert.equal(remote.files.get("/r/a.py")!.content, "A2")
    assert.equal(pulled["/r/a.py"], `${remote.files.get("/r/a.py")!.mtime}:2`)
  })

  it("REFUSES to push when the remote changed since the last pull", async () => {
    const remote = fakeRemote({ "/r/a.py": "A" })
    const { engine, manifest, writeLocal } = await engineWith(remote)
    manifest.register("/r/a.py")
    await engine.pull(["/r/a.py"])
    remote.touch("/r/a.py", "edited on the remote by bash")
    await writeLocal("/r/a.py", "A2")
    await assert.rejects(engine.push(["/r/a.py"]), /changed on the remote since it was last pulled/)
    assert.equal(remote.files.get("/r/a.py")!.content, "edited on the remote by bash", "remote must be preserved")
  })

  it("REFUSES to push over a remote file that was never pulled (the original bug)", async () => {
    const remote = fakeRemote({ "/r/a.py": "the real file" })
    const { engine, manifest, writeLocal } = await engineWith(remote)
    manifest.register("/r/a.py")
    await writeLocal("/r/a.py", "stale mirror copy")
    await assert.rejects(engine.push(["/r/a.py"]), /never pulled into the local mirror/)
    assert.equal(remote.files.get("/r/a.py")!.content, "the real file")
  })

  it("allows a genuinely new remote file and stamps it", async () => {
    const remote = fakeRemote({})
    const { engine, manifest, pulled, writeLocal } = await engineWith(remote)
    manifest.register("/r/new.py")
    const [existed] = await engine.pull(["/r/new.py"])
    assert.equal(existed, false)
    await writeLocal("/r/new.py", "N")
    await engine.push(["/r/new.py"])
    assert.equal(remote.files.get("/r/new.py")!.content, "N")
    assert.ok(pulled["/r/new.py"], "stamp recorded after push")
  })

  it("pull reports remote existence per path", async () => {
    const remote = fakeRemote({ "/r/a.py": "A" })
    const { engine, manifest } = await engineWith(remote)
    manifest.register("/r/a.py"); manifest.register("/r/missing.py")
    assert.deepEqual(await engine.pull(["/r/a.py", "/r/missing.py"]), [true, false])
  })
})
