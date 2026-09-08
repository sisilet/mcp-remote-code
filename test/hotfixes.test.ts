import { test } from "node:test"
import assert from "node:assert/strict"
import { isUnderRoot } from "../src/root-jail.ts"
import { BoundedBuffer, DEFAULT_MAX_OUTPUT_BYTES } from "../src/ssh-pool.ts"
import { createSSHConnection } from "../src/ssh-connection.ts"
import { buildRemoteConfig } from "../src/config.ts"
import { FakeClient, fakeConnector } from "./fixtures/fake-ssh-client.ts"

// 0.2 / F-2: root "/" and prefix-trap edge cases
test("isUnderRoot handles root '/'", () => {
  assert.equal(isUnderRoot("/", "/volume1"), true)
  assert.equal(isUnderRoot("/", "/"), true)
  assert.equal(isUnderRoot("/", "/a/b/c"), true)
})
test("isUnderRoot rejects sibling prefixes", () => {
  assert.equal(isUnderRoot("/media", "/mediax"), false)
  assert.equal(isUnderRoot("/a", "/b"), false)
  assert.equal(isUnderRoot("/media", "/media/x"), true)
})
test("isUnderRoot tolerates a trailing-slash root", () => {
  assert.equal(isUnderRoot("/a/", "/a/b"), true)
})

// 0.4 / P-5: multi-byte UTF-8 split across chunk boundaries must not corrupt
test("BoundedBuffer decodes UTF-8 split across chunks", () => {
  const s = "測試中文字符"                      // 6 CJK chars
  const full = Buffer.from(s, "utf-8")
  const buf = new BoundedBuffer(DEFAULT_MAX_OUTPUT_BYTES)
  for (let i = 0; i < full.length; i++) buf.push(full.subarray(i, i + 1)) // 1 byte at a time
  assert.equal(buf.toString(), s)
})

// 0.4 / F-8: cap enforced, marked truncated
test("BoundedBuffer caps output and marks truncation", () => {
  const buf = new BoundedBuffer(10)
  buf.push(Buffer.from("0123456789ABCDEF"))
  const out = buf.toString()
  assert.ok(out.startsWith("0123456789"))
  assert.ok(out.includes("truncated"))
})
test("BoundedBuffer passes through under the cap", () => {
  const buf = new BoundedBuffer(100)
  buf.push(Buffer.from("hello"))
  assert.equal(buf.toString(), "hello")
})

// Channel semaphore accounting. The Phase 2 exec retry released a slot inside
// a retry branch AND in `finally`, so the count drifted, inFlight stuck above
// the cap, and every later acquire queued a waiter that never resolved. The
// live symptom was the MCP server hanging on all targets; the test runner
// reported "Promise resolution is still pending but the event loop has already
// resolved".
//
// This test used to reimplement a correct semaphore here and assert against
// that, which proved only that the test was right (review F-33). It now drives
// the real connection, so it fails if the production accounting regresses.
test("the channel cap holds under repeated channel-open failures", async () => {
  const MAX = 2
  const previous = process.env.REMOTE_MAX_CHANNELS
  process.env.REMOTE_MAX_CHANNELS = String(MAX)

  try {
    const connector = fakeConnector()
    const pool = await createSSHConnection(
      buildRemoteConfig("ssh test@127.0.0.1", "/home/test/project", {}),
      { connect: connector.connect }
    )
    const client = connector.clients[0]

    let concurrent = 0
    let peak = 0
    // Every channel is refused, which is the retrying path: the command never
    // started, so the pool tries again. The refusal is held briefly rather
    // than answered immediately, so that callers genuinely overlap and the
    // cap is measurable — answering synchronously makes every peak look like
    // one no matter how badly the count has drifted.
    client.exec = (_command: string, cb: (err: Error | undefined, stream: any) => void) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      setTimeout(() => {
        concurrent--
        cb(new Error("Channel open failure: open failed"), undefined as any)
      }, 5)
    }

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => pool.exec("echo hi"))
    )
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected", "every attempt was refused")
    }
    assert.ok(peak <= MAX, `never exceeded the cap (peak ${peak})`)

    // The slots must all be back: a leaked one wedges every later caller.
    client.exec = FakeClient.prototype.exec.bind(client)
    const after = await Promise.all(
      Array.from({ length: 6 }, () => pool.exec("echo recovered"))
    )
    assert.equal(after.length, 6, "the pool still serves callers after the failures")
    await pool.close()
  } finally {
    if (previous === undefined) delete process.env.REMOTE_MAX_CHANNELS
    else process.env.REMOTE_MAX_CHANNELS = previous
  }
})
