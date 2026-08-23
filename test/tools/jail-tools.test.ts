import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ConnectionManager } from "../../src/connection-manager.js"
import { evaluateBashExecution } from "../../src/tools/remote-bash.js"
import { jailRemoteDir, jailRemotePath, requireConnection } from "../../src/tool-utils.js"
import { createFakeSSHPool } from "../fixtures/fake-ssh-pool.js"
import { createTestConnection } from "../fixtures/test-connection.js"

const ROOT = "/home/test/project"

describe("tool jail integration", () => {
  it("jailRemoteDir defaults to root", async () => {
    const pool = createFakeSSHPool({})
    const conn = await createTestConnection(pool, ROOT)
    const result = jailRemoteDir(conn)
    assert.equal(result.path, ROOT)
  })

  it("jailRemotePath rejects outside paths before SSH file ops", async () => {
    const pool = createFakeSSHPool({})
    const conn = await createTestConnection(pool, ROOT)
    const result = await jailRemotePath(conn, "/home/test/secret/outside.txt")
    assert.match("errorText" in result ? result.errorText : "", /outside the allowed root/)
    assert.equal(pool.calls.length, 0)
  })

  it("evaluateBashExecution pins cwd to root by default", () => {
    const result = evaluateBashExecution(ROOT)
    assert.equal(result.actualCwd, ROOT)
    assert.equal(result.needsOutsideConfirm, false)
  })

  it("evaluateBashExecution marks outside cwd as needing confirmation", () => {
    const result = evaluateBashExecution(ROOT, "/tmp")
    assert.equal(result.needsOutsideConfirm, true)
  })

  it("evaluateBashExecution honors outside flag", () => {
    const result = evaluateBashExecution(ROOT, undefined, true)
    assert.equal(result.needsOutsideConfirm, true)
  })

  it("requires target when multiple connections exist", async () => {
    const pool = createFakeSSHPool({})
    const connA = await createTestConnection(pool, ROOT)
    connA.name = "alpha"
    const connB = await createTestConnection(pool, ROOT)
    connB.name = "beta"
    const manager = new ConnectionManager()
    manager.setConnectionForTest(connA)
    manager.setConnectionForTest(connB)

    const result = requireConnection(manager)
    assert.match("errorText" in result ? result.errorText : "", /Multiple targets configured/)
  })
})
