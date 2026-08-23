import { execFile, spawn } from "node:child_process"
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

export async function startDockerFixture(): Promise<void> {
  await execFileAsync("docker", ["compose", "up", "-d", "--wait"], {
    cwd: dockerDir,
  })
  await waitForSsh()
}

export async function stopDockerFixture(): Promise<void> {
  await execFileAsync("docker", ["compose", "down"], { cwd: dockerDir }).catch(() => {})
}

async function waitForSsh(maxAttempts = 30): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await execFileAsync("ssh", [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        "2222",
        "test@127.0.0.1",
        "echo",
        "ready",
      ], {
        env: { ...process.env, SSH_ASKPASS: "", DISPLAY: "" },
        timeout: 5_000,
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error("Docker SSH fixture did not become ready in time")
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
