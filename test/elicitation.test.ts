import { test } from "node:test"
import assert from "node:assert/strict"
import { confirmWithUser, initElicitation, resolveMode } from "../src/elicitation.ts"

test("resolveMode: per-target overrides global", () => {
  initElicitation({} as any, "on")
  assert.equal(resolveMode(undefined), "on")
  assert.equal(resolveMode("off"), "off")
  initElicitation({} as any, "off")
  assert.equal(resolveMode(undefined), "off")
})

test("disabled in config does not approve and does not prompt", async () => {
  initElicitation({} as any, "off")
  const r = await confirmWithUser("do the thing")
  assert.equal(r.approved, false)
  assert.equal(r.via, "disabled")
})

test("client without elicitation capability does not approve", async () => {
  initElicitation({ server: { getClientCapabilities: () => ({}) } } as any, "on")
  const r = await confirmWithUser("do the thing")
  assert.equal(r.approved, false)
  assert.equal(r.via, "unsupported")
})

test("user acceptance approves", async () => {
  initElicitation({
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => ({ action: "accept", content: { approve: true } }),
    },
  } as any, "on")
  const r = await confirmWithUser("do the thing")
  assert.equal(r.approved, true)
  assert.equal(r.via, "user-accepted")
})

test("decline, and answering no, both refuse", async () => {
  const mk = (res: any) => ({
    server: { getClientCapabilities: () => ({ elicitation: {} }), elicitInput: async () => res },
  }) as any
  initElicitation(mk({ action: "decline" }), "on")
  assert.equal((await confirmWithUser("x")).approved, false)
  initElicitation(mk({ action: "accept", content: { approve: false } }), "on")
  assert.equal((await confirmWithUser("x")).approved, false)
})

test("an elicitation error fails closed", async () => {
  initElicitation({
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async () => { throw new Error("transport gone") },
    },
  } as any, "on")
  const r = await confirmWithUser("x")
  assert.equal(r.approved, false)
  assert.equal(r.via, "error")
})
