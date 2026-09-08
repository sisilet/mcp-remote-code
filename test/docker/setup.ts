import { execFile, spawn } from "node:child_process"
import { Socket } from "node:net"
import { promisify } from "node:util"
import path from "node:path"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const dockerDir = path.dirname(fileURLToPath(import.meta.url))

export const DOCKER_ROOT = "/home/test/project"
export const DOCKER_SSH = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 test@127.0.0.1`

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function waitForSsh(maxAttempts = 30): Promise<void> {
  // Probe the TCP port, not an ssh login. The fixture uses password auth, so
  // shelling out to `ssh` can never succeed non-interactively: it prompts,
  // fails, and the fixture is reported as never ready even though sshd is up.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = new Socket()
      const done = (ok: boolean) => {
        socket.destroy()
        resolve(ok)
      }
      socket.setTimeout(2_000)
      socket.once("connect", () => done(true))
      socket.once("timeout", () => done(false))
      socket.once("error", () => done(false))
      socket.connect(2222, "127.0.0.1")
    })
    if (open) {
      // sshd accepts connections a moment before the custom init script has
      // finished creating the fixture files; give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error("Docker SSH fixture did not become ready in time")
}

/**
 * Node's test runner gives each test FILE its own process, so a
 * reference count in module scope is not shared between suites. Instead:
 * starting is idempotent (compose up on a running container is a no-op), and
 * stopping is deliberately a no-op. The container is torn down once, before
 * the run, by the test:docker script.
 *
 * Previously each suite stopped the fixture in its `after` hook, so whichever
 * finished first killed the container out from under the other and both
 * suites failed.
 */
export async function startDockerFixture(): Promise<void> {
  await execFileAsync("docker", ["compose", "up", "-d", "--wait"], { cwd: dockerDir })
  await waitForSsh()
}

/** No-op: see startDockerFixture. Use `npm run test:docker:down` to clean up. */
export async function stopDockerFixture(): Promise<void> {}

export async function teardownDockerFixture(): Promise<void> {
  await execFileAsync("docker", ["compose", "down", "-v"], { cwd: dockerDir }).catch(() => {})
}

export function runCompose(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: dockerDir,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker compose ${args.join(" ")} failed with code ${code}`))
    })
  })
}
