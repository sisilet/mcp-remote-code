import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ConnectionManager, RETRY_COOLDOWN_MS } from "../src/connection-manager.js"
import { requireConnection } from "../src/tool-utils.js"
import { createFakeSSHPool } from "./fixtures/fake-ssh-pool.js"
import { createTestConnection } from "./fixtures/test-connection.js"

describe("connectAll resilience", () => {
  it("keeps online targets when one connect fails", async () => {
    const manager = new ConnectionManager()
    ;(manager as any).connectStartup = async (startup: { name: string }) => {
      if (startup.name === "galaxy-s26") {
        throw new Error("connect ECONNREFUSED 192.168.0.36:8022")
      }
      const conn = await createTestConnection(createFakeSSHPool({}), "/root")
      conn.name = startup.name
      manager.setConnectionForTest(conn)
      return {
        name: startup.name,
        transport: "ssh",
        host: "host",
        user: "user",
        port: 22,
        workdir: "/root",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      }
    }

    const result = await manager.connectAll([
      {
        name: "genie",
        sshCommand: "ssh user@host",
        root: "/root",
      },
      {
        name: "galaxy-s26",
        sshCommand: "ssh root@phone",
        root: "/mnt/android",
      },
    ])

    assert.equal(result.connected.length, 1)
    assert.equal(result.connected[0].name, "genie")
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].name, "galaxy-s26")
    assert.match(result.failed[0].error, /ECONNREFUSED/)
    assert.ok(manager.get("genie"))
    assert.equal(manager.get("galaxy-s26"), undefined)
    assert.ok(manager.hasFailed("galaxy-s26"))
  })

  it("fails only when every target is offline", async () => {
    const manager = new ConnectionManager()
    ;(manager as any).connectStartup = async () => {
      throw new Error("timed out")
    }

    await assert.rejects(
      () =>
        manager.connectAll([
          { name: "a", sshCommand: "ssh a@h", root: "/a" },
          { name: "b", sshCommand: "ssh b@h", root: "/b" },
        ]),
      /No targets connected/
    )
  })

  it("connects a local target without SSH", async () => {
    const manager = new ConnectionManager()
    const root = process.cwd()
    const info = await manager.connectStartup({
      name: "mcp-remote-code",
      type: "local",
      sshCommand: "",
      root,
    })
    assert.equal(info.transport, "local")
    assert.equal(info.workdir, root)
    assert.ok(manager.get("mcp-remote-code"))
    await manager.close()
  })

  it("retries a failed target after cooldown via requireConnection", async () => {
    const manager = new ConnectionManager()
    const online = await createTestConnection(createFakeSSHPool({}), "/root")
    online.name = "genie"
    manager.setConnectionForTest(online)

    const startup = {
      name: "galaxy-s26",
      type: "ssh" as const,
      sshCommand: "ssh root@phone",
      root: "/mnt/android",
    }
    manager.setFailedForTest(startup, "connect ECONNREFUSED", Date.now() - RETRY_COOLDOWN_MS - 1)

    let attempts = 0
    ;(manager as any).connectStartup = async (s: { name: string }) => {
      attempts++
      const conn = await createTestConnection(createFakeSSHPool({}), "/mnt/android")
      conn.name = s.name
      manager.setConnectionForTest(conn)
      manager["failedTargets"].delete(s.name)
      return {
        name: s.name,
        transport: "ssh",
        host: "phone",
        user: "root",
        port: 8022,
        workdir: "/mnt/android",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      }
    }

    const result = await requireConnection(manager, "galaxy-s26")
    assert.ok(!("errorText" in result))
    assert.equal(attempts, 1)
    assert.ok(manager.get("galaxy-s26"))
    assert.equal(manager.hasFailed("galaxy-s26"), false)
  })

  it("throttles reconnect attempts inside the cooldown window", async () => {
    const manager = new ConnectionManager()
    const startup = {
      name: "galaxy-s26",
      type: "ssh" as const,
      sshCommand: "ssh root@phone",
      root: "/mnt/android",
    }
    manager.setFailedForTest(startup, "connect ECONNREFUSED", Date.now())

    let attempts = 0
    ;(manager as any).connectStartup = async () => {
      attempts++
      throw new Error("should not run")
    }

    const result = await requireConnection(manager, "galaxy-s26")
    assert.ok("errorText" in result)
    assert.match(result.errorText, /offline/)
    assert.match(result.errorText, /retry/i)
    assert.equal(attempts, 0)
  })

  it("reports offline target clearly from requireConnection", async () => {
    const manager = new ConnectionManager()
    const conn = await createTestConnection(createFakeSSHPool({}), "/root")
    conn.name = "genie"
    manager.setConnectionForTest(conn)
    manager.setFailedForTest(
      {
        name: "galaxy-s26",
        sshCommand: "ssh root@phone",
        root: "/mnt/android",
      },
      "connect ECONNREFUSED",
      Date.now()
    )

    const missing = await requireConnection(manager, "galaxy-s26")
    assert.ok("errorText" in missing)
    assert.match(missing.errorText, /offline/)
    assert.match(missing.errorText, /ECONNREFUSED/)
    assert.match(missing.errorText, /genie/)

    const online = await requireConnection(manager, "genie")
    assert.ok(!("errorText" in online))
  })

  it("dedupes concurrent retryFailed calls into one connect attempt", async () => {
    const manager = new ConnectionManager()
    const startup = {
      name: "galaxy-s26",
      type: "ssh" as const,
      sshCommand: "ssh root@phone",
      root: "/mnt/android",
    }
    manager.setFailedForTest(startup, "connect ECONNREFUSED", Date.now() - RETRY_COOLDOWN_MS - 1)

    let attempts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    ;(manager as any).connectStartup = async (s: { name: string }) => {
      attempts++
      await gate
      const conn = await createTestConnection(createFakeSSHPool({}), "/mnt/android")
      conn.name = s.name
      manager.setConnectionForTest(conn)
      manager["failedTargets"].delete(s.name)
      return {
        name: s.name,
        transport: "ssh",
        host: "phone",
        user: "root",
        port: 8022,
        workdir: "/mnt/android",
        platform: "linux",
        isGitRepo: false,
        connected: true,
      }
    }

    const p1 = manager.retryFailed("galaxy-s26")
    const p2 = manager.retryFailed("galaxy-s26")
    assert.equal(attempts, 1)
    release()
    const [a, b] = await Promise.all([p1, p2])
    assert.ok(a)
    assert.equal(a, b)
    assert.equal(attempts, 1)
  })

  it("records a fresh error when reconnect still fails", async () => {
    const manager = new ConnectionManager()
    const startup = {
      name: "galaxy-s26",
      type: "ssh" as const,
      sshCommand: "ssh root@phone",
      root: "/mnt/android",
    }
    manager.setFailedForTest(startup, "connect ECONNREFUSED", Date.now() - RETRY_COOLDOWN_MS - 1)

    ;(manager as any).connectStartup = async () => {
      throw new Error("connect ETIMEDOUT")
    }

    const result = await manager.retryFailed("galaxy-s26")
    assert.equal(result, null)
    assert.equal(manager.hasFailed("galaxy-s26"), true)
    assert.match(manager.getFailedError("galaxy-s26") ?? "", /ETIMEDOUT/)
    assert.ok((manager.getFailedRetryAfterMs("galaxy-s26") ?? 0) > 0)

    // Still inside cooldown — no second attempt.
    let attempts = 0
    ;(manager as any).connectStartup = async () => {
      attempts++
      throw new Error("should not run")
    }
    assert.equal(await manager.retryFailed("galaxy-s26"), null)
    assert.equal(attempts, 0)
  })
})
