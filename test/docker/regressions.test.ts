import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { ConnectionManager } from "../../src/connection-manager.js"
import { remoteRealpath } from "../../src/root-jail.js"
import {
  DOCKER_ROOT,
  DOCKER_SSH,
  isDockerAvailable,
  startDockerFixture,
  stopDockerFixture,
} from "./setup.js"

/**
 * Regressions for defects found during the v2.1.1 -> v3.1.0 work that unit
 * tests could not have caught: they need a real SSH server, and several only
 * appear under concurrency or against a specific server configuration.
 */

const dockerAvailable = await isDockerAvailable()

if (!dockerAvailable) {
  describe("docker regressions", () => {
    it("skips when Docker is not available", () => {})
  })
} else {
  describe("docker regressions", () => {
    let manager: ConnectionManager
    let conn: any

    before(async () => {
      await startDockerFixture()
      manager = new ConnectionManager()
      await manager.connect("docker", DOCKER_SSH, DOCKER_ROOT, "testpass")
      conn = manager.get("docker")
    })

    after(async () => {
      // Closing the manager is not optional: without it the SSH connection
      // stays open, the process cannot exit, and node:test reports
      // "Promise resolution is still pending but the event loop has already
      // resolved" for the whole file even though every assertion passed.
      await manager.close()
      await stopDockerFixture()
    })

    // P-5: decoding each chunk separately splits multi-byte characters.
    it("preserves multi-byte UTF-8 in command output", async () => {
      const text = "測試中文字符 ünïcødé emoji"
      const r = await conn.sshPool.exec(`printf '%s' ${JSON.stringify(text)}`, { timeout: 15_000 })
      assert.equal(r.stdout, text)
    })

    // P-5 again, at a size that guarantees chunk boundaries mid-character.
    it("preserves UTF-8 across many chunk boundaries", async () => {
      const r = await conn.sshPool.exec(
        `for i in $(seq 1 2000); do printf '測試中文字符'; done`,
        { timeout: 30_000 }
      )
      assert.equal(r.stdout.length, 6 * 2000)
      assert.ok(!r.stdout.includes("\uFFFD"), "no replacement characters")
    })

    // F-8: a runaway command must not be buffered without limit.
    it("caps runaway output and marks it truncated", async () => {
      const r = await conn.sshPool.exec("yes abcdefghij | head -c 3000000", {
        timeout: 30_000,
        maxOutputBytes: 64 * 1024,
      })
      assert.ok(r.stdout.length < 200_000, `expected capped output, got ${r.stdout.length}`)
      assert.match(r.stdout, /truncated/)
    })

    // F-17: exit code is the verdict; stderr text is not.
    it("reports success when a command writes to stderr but exits 0", async () => {
      const r = await conn.sshPool.exec("echo oops >&2; echo fine", { timeout: 15_000 })
      assert.equal(r.exitCode, 0)
      assert.match(r.stdout, /fine/)
      assert.match(r.stderr, /oops/)
    })

    it("reports the real non-zero exit code", async () => {
      const r = await conn.sshPool.exec("exit 42", { timeout: 15_000 })
      assert.equal(r.exitCode, 42)
    })

    // P-1 / channel exhaustion: concurrency must not exceed MaxSessions.
    it("handles concurrent execs over a single connection", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          conn.sshPool.exec(`echo c${i}`, { timeout: 30_000 })
        )
      )
      results.forEach((r: any, i: number) => assert.equal(r.stdout.trim(), `c${i}`))
    })

    // 2.4: the SFTP session is reused, and rapid reuse must not exhaust channels.
    it("resolves many paths without exhausting channels", async () => {
      for (let i = 0; i < 25; i++) {
        const resolved = await remoteRealpath(conn.sshPool, `${DOCKER_ROOT}/hello.txt`)
        assert.equal(resolved, `${DOCKER_ROOT}/hello.txt`)
      }
    })

    // 3.1: SFTP realpath returns a missing path unchanged rather than failing,
    // so existence must be checked explicitly or every missing path looks real.
    it("returns null for a missing path", async () => {
      assert.equal(await remoteRealpath(conn.sshPool, `${DOCKER_ROOT}/__missing__`), null)
    })

    // 3.1: the jail's guarantee. A symlink must resolve to its true target.
    it("resolves a symlink to its target outside the root", async () => {
      const resolved = await remoteRealpath(conn.sshPool, `${DOCKER_ROOT}/escape`)
      assert.equal(resolved, "/home/test/secret/outside.txt")
    })

    // F-7: a timed-out command must not leave the connection unusable.
    it("stays usable after a command times out", async () => {
      await assert.rejects(
        () => conn.sshPool.exec("sleep 30", { timeout: 2_000 }),
        /timeout/i
      )
      const after = await conn.sshPool.exec("echo recovered", { timeout: 15_000 })
      assert.match(after.stdout, /recovered/)
    })

    // F-15: a leading dash must be quoted, not read as an option.
    it("handles paths that look like options", async () => {
      await conn.sshPool.exec(`cd ${DOCKER_ROOT} && printf x > -weird.txt`, { timeout: 15_000 })
      const resolved = await remoteRealpath(conn.sshPool, `${DOCKER_ROOT}/-weird.txt`)
      assert.equal(resolved, `${DOCKER_ROOT}/-weird.txt`)
      await conn.sshPool.exec(`cd ${DOCKER_ROOT} && rm -- -weird.txt`, { timeout: 15_000 })
    })
  })
}
