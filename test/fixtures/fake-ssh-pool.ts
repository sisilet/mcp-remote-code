import type { SSHPool } from "../../src/ssh-pool.js"

export interface ExecCall {
  command: string
  options?: { cwd?: string; timeout?: number }
}

export function createFakeSSHPool(handlers: {
  exec?: (call: ExecCall) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  realpaths?: Record<string, string | null>
}): SSHPool & { calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const realpaths = handlers.realpaths ?? {}

  return {
    calls,
    async exec(command, options = {}) {
      calls.push({ command, options })

      if (command.includes("readlink -f") || command.includes("realpath")) {
        const match = command.match(/if \[ -e ([^\s]+) \]/)
        const quoted = match?.[1] ?? ""
        const path = quoted.replace(/^'|'$/g, "").replace(/^"|"$/g, "")
        const mapped = Object.prototype.hasOwnProperty.call(realpaths, path)
          ? realpaths[path]
          : path
        if (mapped === null) {
          return { stdout: "__MISSING__\n", stderr: "", exitCode: 0 }
        }
        return { stdout: `${mapped ?? path}\n`, stderr: "", exitCode: 0 }
      }

      if (handlers.exec) {
        return handlers.exec({ command, options })
      }

      return { stdout: "", stderr: "", exitCode: 0 }
    },
    async withSftp<T>(fn: (sftp: any) => Promise<T>): Promise<T> {
      return fn({
        end: () => {},
        fastGet: async () => {},
        fastPut: async () => {},
      })
    },
    async close() {},
  }
}
