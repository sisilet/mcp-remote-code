import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { ConnectionManager } from "../../src/connection-manager.js"
import { jailRemotePath } from "../../src/tool-utils.js"
import {
  DOCKER_ROOT,
  DOCKER_SSH,
  isDockerAvailable,
  startDockerFixture,
  stopDockerFixture,
} from "./setup.js"

const dockerAvailable = await isDockerAvailable()
if (!dockerAvailable) {
  describe("docker ssh live", () => {
    it("skips when Docker is not available", () => {
      console.log("SKIP: Docker is not available. Install and start Docker to run test:docker.")
    })
  })
} else {
  describe("docker ssh live", () => {
    let manager: ConnectionManager

    before(async () => {
      await startDockerFixture()
      manager = new ConnectionManager()
      await manager.connect("docker", DOCKER_SSH, DOCKER_ROOT, "testpass")
    })

    after(async () => {
      await manager.close()
      await stopDockerFixture()
    })

    it("reads hello.txt inside root", async () => {
      const conn = manager.get()
      assert.ok(conn)
      const jailed = await jailRemotePath(conn, "hello.txt")
      assert.equal("path" in jailed ? jailed.path : "", `${DOCKER_ROOT}/hello.txt`)

      const result = await conn.sshPool.exec(`cat ${DOCKER_ROOT}/hello.txt`)
      assert.match(result.stdout, /hello/)
    })

    it("rejects outside file paths", async () => {
      const conn = manager.get()
      assert.ok(conn)
      const jailed = await jailRemotePath(conn, "/home/test/secret/outside.txt")
      assert.match("errorText" in jailed ? jailed.errorText : "", /outside the allowed root/)
    })

    it("rejects symlink escape via realpath", async () => {
      const conn = manager.get()
      assert.ok(conn)
      const jailed = await jailRemotePath(conn, `${DOCKER_ROOT}/escape`)
      assert.match("errorText" in jailed ? jailed.errorText : "", /outside the allowed root/)
    })

    it("runs remote_bash in root cwd", async () => {
      const conn = manager.get()
      assert.ok(conn)
      const result = await conn.sshPool.exec("pwd", { cwd: DOCKER_ROOT })
      assert.match(result.stdout.trim(), new RegExp(DOCKER_ROOT.replace(/\//g, "\\/")))
    })
  })
}
