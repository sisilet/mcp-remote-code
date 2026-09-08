import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { clearConfirmations } from "../../src/confirmation.js"
import { ConnectionManager } from "../../src/connection-manager.js"
import { handleRemoteBash } from "../../src/tools/remote-bash.js"
import { createFakeSSHPool } from "../fixtures/fake-ssh-pool.js"
import { createTestConnection } from "../fixtures/test-connection.js"

const ROOT = "/home/test/project"

describe("remote_bash", () => {
  it("runs in-root commands without confirmation", async () => {
    clearConfirmations()
    const pool = createFakeSSHPool({
      exec: async () => ({ stdout: "/home/test/project\n", stderr: "", exitCode: 0 }),
    })
    const conn = await createTestConnection(pool, ROOT)
    const manager = new ConnectionManager()
    manager.setConnectionForTest(conn)

    const result = await handleRemoteBash(manager, {
      command: "pwd",
      description: "print cwd",
    })

    assert.match(result.content[0].text, /\/home\/test\/project/)
    assert.equal(pool.calls.length, 1)
    assert.equal(pool.calls[0].options.cwd, ROOT)
  })

  it("does not execute outside commands until force is set", async () => {
    clearConfirmations()
    const pool = createFakeSSHPool({
      exec: async () => ({ stdout: "secret\n", stderr: "", exitCode: 0 }),
    })
    const conn = await createTestConnection(pool, ROOT)
    const manager = new ConnectionManager()
    manager.setConnectionForTest(conn)

    const first = await handleRemoteBash(manager, {
      command: "cat /home/test/secret/outside.txt",
      description: "read outside",
      outside: true,
    })
    assert.match(first.content[0].text, /paths outside the configured root/)
    assert.equal(pool.calls.length, 0)

    const second = await handleRemoteBash(manager, {
      command: "cat /home/test/secret/outside.txt",
      description: "read outside",
      outside: true,
      force: true,
    })
    assert.match(second.content[0].text, /secret/)
    assert.equal(pool.calls.length, 1)
  })
})
