import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { buildRemoteConfig } from "../src/config.ts"
import {
  appendSignal,
  createSSHConnection,
  exitCodeFrom,
} from "../src/ssh-connection.ts"
import { fakeConnector } from "./fixtures/fake-ssh-client.ts"

const config = buildRemoteConfig("ssh test@127.0.0.1", "/home/test/project", {})

const settled = () => new Promise((r) => setTimeout(r, 5))

describe("F-31 reconnect is single-flight", () => {
  it("opens one replacement transport however many callers are waiting", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    assert.equal(connector.calls, 1)

    // The transport dies with nobody holding it.
    connector.clients[0].killTransport()

    // Everything that was queued now needs a connection at once. Before the
    // fix each of these called connect() and all but the last transport was
    // abandoned: a live socket locally and an sshd process remotely.
    connector.block()
    const inflight = Array.from({ length: 6 }, () => pool.exec("echo hi"))
    await settled()
    connector.release()
    await Promise.all(inflight)

    assert.equal(connector.calls, 2, "six callers must share one reconnect")
    assert.equal(connector.clients.length, 2)
    await pool.close()
  })

  it("opens exactly one transport per death, across repeated reconnects", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })

    for (let i = 0; i < 3; i++) {
      connector.clients[connector.clients.length - 1].killTransport()
      // Three callers race into each reconnect.
      await Promise.all([pool.exec("a"), pool.exec("b"), pool.exec("c")])
    }

    assert.equal(connector.calls, 4, "one initial connect plus one per death, and no more")
    assert.equal(connector.clients.length, 4)
    await pool.close()
  })

  it("ends a transport it replaces while still alive", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const first = connector.clients[0]

    await pool.close()

    assert.ok(first.ended, "close() must end the live transport rather than drop the reference")
  })

  it("reports a failed reconnect to every waiting caller, and retries later", async () => {
    const connector = fakeConnector()
    let failNext = false
    const connect = async (): Promise<any> => {
      if (failNext) throw new Error("connect refused")
      return connector.connect()
    }
    const pool = await createSSHConnection(config, { connect })

    connector.clients[0].killTransport()
    failNext = true
    const outcomes = await Promise.allSettled([pool.exec("a"), pool.exec("b")])
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected", "a failed reconnect must reach every caller")
    }

    // A failed attempt must not wedge the single-flight slot.
    failNext = false
    await pool.exec("recovered")
    await pool.close()
  })
})

describe("F-32 a dying transport does not corrupt the channel count", () => {
  const previous = process.env.REMOTE_MAX_CHANNELS

  before(() => {
    process.env.REMOTE_MAX_CHANNELS = "2"
  })
  after(() => {
    if (previous === undefined) delete process.env.REMOTE_MAX_CHANNELS
    else process.env.REMOTE_MAX_CHANNELS = previous
  })

  it("fails queued callers instead of handing them phantom slots", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const client = connector.clients[0]
    client.autoFinish = false

    // Fill both slots, then queue two more.
    const held = [pool.exec("hold-1"), pool.exec("hold-2")]
    await settled()
    const queued = [pool.exec("queued-1"), pool.exec("queued-2")]
    await settled()
    assert.equal(client.execCommands.length, 2, "the cap must hold the extra callers back")

    client.killTransport()

    // Queued callers must settle. Before the fix they were resolved as if
    // they held a slot, which drifted the count and disabled the cap; a
    // waiter that simply hung was the other possible outcome.
    const outcomes = await Promise.allSettled(queued)
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected", "a queued caller must be told the transport died")
    }

    // Release the two that were running.
    for (const stream of client.streams) stream.finish(0)
    await Promise.allSettled(held)

    // The cap must still apply afterwards.
    const next = connector.clients[connector.clients.length - 1]
    next.autoFinish = false
    const after = Array.from({ length: 5 }, (_, i) => pool.exec(`later-${i}`))
    await settled()
    assert.ok(
      next.execCommands.length <= 2,
      `cap still enforced after a transport death (saw ${next.execCommands.length} concurrent)`
    )
    for (const stream of next.streams) stream.finish(0)
    await Promise.allSettled(after)
    await pool.close()
  })
})

describe("F-34 timeout landing before the channel opens", () => {
  it("kills the channel that arrives late instead of walking away from it", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const client = connector.clients[0]
    client.execDelayMs = 40
    client.autoFinish = false

    await assert.rejects(pool.exec("sleep 60", { timeout: 10 }), /timeout/i)

    // The stream shows up after the timeout has already rejected.
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(client.streams.length, 1, "the channel did open, late")
    assert.ok(
      client.streams[0].killed,
      "a channel that opens after its timeout must be killed, not left running"
    )
    await pool.close()
  })

  it("kills the channel when the timeout fires while it is running", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const client = connector.clients[0]
    client.autoFinish = false

    await assert.rejects(pool.exec("sleep 60", { timeout: 20 }), /timeout/i)

    assert.equal(client.streams[0].signalled, "KILL")
    await pool.close()
  })
})

describe("F-35 signal termination is not success", () => {
  it("reports a signal-killed command as a failure", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const client = connector.clients[0]
    client.autoFinish = false

    const running = pool.exec("long-running")
    await settled()
    client.streams[0].finish(null, "SIGKILL")

    const result = await running
    assert.notEqual(result.exitCode, 0, "a signal kill must not be reported as exit 0")
    assert.match(result.stderr, /SIGKILL/)
    await pool.close()
  })

  it("still reports an ordinary exit code", async () => {
    const connector = fakeConnector()
    const pool = await createSSHConnection(config, { connect: connector.connect })
    const client = connector.clients[0]
    client.autoFinish = false

    const running = pool.exec("false")
    await settled()
    client.streams[0].finish(3)

    assert.equal((await running).exitCode, 3)
    await pool.close()
  })

  it("maps close arguments the way ssh2 delivers them", () => {
    assert.equal(exitCodeFrom(0, undefined), 0)
    assert.equal(exitCodeFrom(3, undefined), 3)
    assert.equal(exitCodeFrom(null, "SIGKILL"), -1)
    assert.equal(exitCodeFrom(undefined, undefined), 0)
    assert.equal(appendSignal("boom", "SIGTERM"), "boom\n[terminated by signal SIGTERM]")
    assert.equal(appendSignal("boom", undefined), "boom")
  })
})
