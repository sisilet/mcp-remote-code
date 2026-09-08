import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SyncEngine } from "../src/sync-engine.js"

/**
 * Regression test for the 2026-09-08 stale-mirror overwrite.
 *
 * remote_write used to call pushAll() after writing one file. pushAll uploads
 * the local mirror's copy of EVERY tracked file. For a NEW file the mirror was
 * not refreshed from the remote first, so every earlier file was overwritten
 * with whatever the mirror last held, silently destroying edits made on the
 * remote outside this tool. Tools now push only what they changed.
 */
describe("SyncEngine.push", () => {
  function fakeEngine(tracked: string[]) {
    const uploaded: string[] = []
    const sftp = {
      fastPut: (_l: string, r: string, cb: (e?: Error) => void) => { uploaded.push(r); cb() },
      stat: (_r: string, cb: (e?: Error, s?: any) => void) => cb(undefined, { mode: 0o644 }),
      chmod: (_r: string, _m: number, cb: (e?: Error) => void) => cb(),
      rename: (_a: string, _b: string, cb: (e?: Error) => void) => cb(),
      unlink: (_r: string, cb: (e?: Error) => void) => cb(),
    }
    const sshPool: any = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      withSftp: async (fn: (s: any) => Promise<void>) => fn(sftp),
    }
    const manifest: any = { remotePaths: () => tracked, register: (p: string) => p, save: async () => {} }
    const pathMapper: any = { toLocal: (p: string) => "/tmp/mirror" + p }
    const engine = new SyncEngine({} as any, pathMapper, manifest, sshPool)
    return { engine, uploaded }
  }

  it("push(paths) uploads only the given files, not every tracked file", async () => {
    const tracked = ["/r/a.py", "/r/b.py", "/r/c.py"]
    const { engine, uploaded } = fakeEngine(tracked)
    await engine.push(["/r/c.py"])
    // The temp-then-rename upload puts to a sibling temp name; check the stem.
    assert.equal(uploaded.length, 1)
    assert.match(uploaded[0], /\.c\.py\.mcp-tmp-/)
    assert.ok(!uploaded.some((u) => u.includes("a.py") || u.includes("b.py")), "untouched tracked files must not be uploaded")
  })

  it("push([]) is a no-op", async () => {
    const { engine, uploaded } = fakeEngine(["/r/a.py"])
    await engine.push([])
    assert.equal(uploaded.length, 0)
  })

  it("pushAll still uploads every tracked file (callers must have pulled first)", async () => {
    const { engine, uploaded } = fakeEngine(["/r/a.py", "/r/b.py"])
    await engine.pushAll()
    assert.equal(uploaded.length, 2)
  })
})
