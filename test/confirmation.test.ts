import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  checkConfirmation,
  clearConfirmations,
  hasFreshConfirmation,
  requestConfirmation,
} from "../src/confirmation.js"

describe("confirmation", () => {
  it("executes immediately when confirmation is not required", () => {
    clearConfirmations()
    const outcome = checkConfirmation(
      "key-1",
      false,
      undefined,
      () => "pending",
      () => "needs force"
    )
    assert.equal(outcome.status, "execute")
  })

  it("returns pending on first outside call even with force", () => {
    clearConfirmations()
    const outcome = checkConfirmation(
      "key-2",
      true,
      true,
      () => "pending message",
      () => "needs force"
    )
    assert.equal(outcome.status, "pending")
    assert.equal(outcome.message, "pending message")
    assert.equal(hasFreshConfirmation("key-2"), true)
  })

  it("requires force on second call", () => {
    clearConfirmations()
    requestConfirmation("key-3")
    const outcome = checkConfirmation(
      "key-3",
      true,
      false,
      () => "pending",
      () => "needs force message"
    )
    assert.equal(outcome.status, "needs_force")
    assert.equal(outcome.message, "needs force message")
  })

  it("executes on second call with force", () => {
    clearConfirmations()
    requestConfirmation("key-4")
    const outcome = checkConfirmation(
      "key-4",
      true,
      true,
      () => "pending",
      () => "needs force"
    )
    assert.equal(outcome.status, "execute")
    assert.equal(hasFreshConfirmation("key-4"), false)
  })

  it("does not confirm a different key", () => {
    clearConfirmations()
    requestConfirmation("key-a")
    const outcome = checkConfirmation(
      "key-b",
      true,
      true,
      () => "pending",
      () => "needs force"
    )
    assert.equal(outcome.status, "pending")
  })
})
