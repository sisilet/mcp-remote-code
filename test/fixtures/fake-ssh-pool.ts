import path from "path"
import type { SSHPool } from "../../src/ssh-pool.js"

export interface ExecCall {
  command: string
  options?: { cwd?: string; timeout?: number }
}

/**
 * An entry in the fake remote filesystem. A bare string is shorthand for a
 * file with that content.
 */
export type FakeEntry =
  | { type: "file"; content: string; mode?: number }
  | { type: "dir" }
  | { type: "symlink"; target: string }

export type FakeFiles = Record<string, FakeEntry | string>

/**
 * Which SFTP operations should fail, and how many times each.
 *
 * The point of the fixture is to reach failure paths. Every serious defect
 * found in the 2026-09-07 review lived in one: a rename that fails, a
 * transport that dies mid-command. Those paths were unreachable from the
 * previous fixture, which is why they were never tested.
 */
export interface FakeFaults {
  rename?: number
  fastPut?: number
  unlink?: number
}

export interface FakeSSHPoolOptions {
  exec?: (call: ExecCall) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Legacy shorthand: remote path -> resolved path, or null for missing. */
  realpaths?: Record<string, string | null>
  /**
   * In-memory remote filesystem. Supplying this switches the fake SFTP
   * session on, which is what makes `remoteRealpath` take its SFTP branch
   * (the branch used against every healthy server, and previously never
   * executed by a test).
   */
  files?: FakeFiles
  /** Working directory reported by `pwd -P` and by SFTP `realpath(".")`. */
  cwd?: string
  /**
   * Report a different SFTP working directory from the shell one, so
   * `sftpMatchesShell` sees an offset namespace and falls back to the shell.
   * This is the DS220j case.
   */
  sftpCwd?: string
  faults?: FakeFaults
}

export interface FakeSSHPool extends SSHPool {
  calls: ExecCall[]
  /** Read the fake filesystem back, for assertions after an operation. */
  read(remotePath: string): string | undefined
  entry(remotePath: string): FakeEntry | undefined
  paths(): string[]
}

export function createFakeSSHPool(options: FakeSSHPoolOptions): FakeSSHPool {
  const calls: ExecCall[] = []
  const realpaths = options.realpaths ?? {}
  const cwd = options.cwd ?? "/home/test/project"
  const hasFs = options.files !== undefined
  const faults: FakeFaults = { ...options.faults }

  const fs = new Map<string, FakeEntry>()
  for (const [p, entry] of Object.entries(options.files ?? {})) {
    fs.set(path.posix.normalize(p), typeof entry === "string" ? { type: "file", content: entry } : entry)
  }

  function takeFault(op: keyof FakeFaults): boolean {
    const remaining = faults[op] ?? 0
    if (remaining <= 0) return false
    faults[op] = remaining - 1
    return true
  }

  /** Resolve symlinks component by component, the way realpath(3) does. */
  function resolve(input: string): string {
    let current = path.posix.normalize(input)
    for (let hops = 0; hops < 16; hops++) {
      const parts = current.split("/").filter(Boolean)
      let built = "/"
      let followed = false
      for (const part of parts) {
        built = path.posix.normalize(path.posix.join(built, part))
        const entry = fs.get(built)
        if (entry?.type === "symlink") {
          const target = path.posix.isAbsolute(entry.target)
            ? entry.target
            : path.posix.join(path.posix.dirname(built), entry.target)
          const rest = current.slice(built.length)
          current = path.posix.normalize(target + rest)
          followed = true
          break
        }
      }
      if (!followed) return current
    }
    return current
  }

  const sftpSession = {
    end: () => {},
    realpath(target: string, cb: (err: Error | undefined, resolved?: string) => void) {
      if (target === ".") {
        cb(undefined, options.sftpCwd ?? cwd)
        return
      }
      // Matches the real thing: realpath does not fail for a missing path,
      // it returns the path resolved as far as it can. Callers must lstat.
      cb(undefined, resolve(target))
    },
    lstat(target: string, cb: (err: Error | undefined, stats?: unknown) => void) {
      const normalized = path.posix.normalize(target)
      const entry = fs.get(normalized)
      if (!entry) {
        cb(Object.assign(new Error("No such file"), { code: 2 }))
        return
      }
      cb(undefined, {
        isDirectory: () => entry.type === "dir",
        isSymbolicLink: () => entry.type === "symlink",
        mode: entry.type === "file" ? entry.mode ?? 0o644 : 0o755,
      })
    },
    stat(target: string, cb: (err: Error | undefined, stats?: unknown) => void) {
      const resolved = resolve(target)
      const entry = fs.get(resolved)
      if (!entry) {
        cb(Object.assign(new Error("No such file"), { code: 2 }))
        return
      }
      cb(undefined, {
        isDirectory: () => entry.type === "dir",
        isSymbolicLink: () => false,
        mode: entry.type === "file" ? entry.mode ?? 0o644 : 0o755,
      })
    },
    chmod(target: string, mode: number, cb: (err?: Error) => void) {
      const entry = fs.get(path.posix.normalize(target))
      if (entry?.type === "file") entry.mode = mode
      cb()
    },
    fastPut(localPath: string, remotePath: string, cb: (err?: Error) => void) {
      if (takeFault("fastPut")) {
        cb(new Error("fastPut failed"))
        return
      }
      // The local side is not modelled; record the local path as content so a
      // test can tell which file was uploaded where.
      fs.set(path.posix.normalize(remotePath), { type: "file", content: `<uploaded ${localPath}>` })
      cb()
    },
    fastGet(remotePath: string, _localPath: string, cb: (err?: Error) => void) {
      const entry = fs.get(resolve(remotePath))
      if (!entry) {
        cb(new Error("No such file"))
        return
      }
      cb()
    },
    unlink(target: string, cb: (err?: Error) => void) {
      if (takeFault("unlink")) {
        cb(new Error("unlink failed"))
        return
      }
      fs.delete(path.posix.normalize(target))
      cb()
    },
    rename(from: string, to: string, cb: (err?: Error) => void) {
      if (takeFault("rename")) {
        cb(new Error("rename failed"))
        return
      }
      const entry = fs.get(path.posix.normalize(from))
      if (!entry) {
        cb(new Error("No such file"))
        return
      }
      fs.delete(path.posix.normalize(from))
      fs.set(path.posix.normalize(to), entry)
      cb()
    },
  }

  return {
    calls,
    read(remotePath) {
      const entry = fs.get(resolve(remotePath))
      return entry?.type === "file" ? entry.content : undefined
    },
    entry(remotePath) {
      return fs.get(path.posix.normalize(remotePath))
    },
    paths() {
      return [...fs.keys()].sort()
    },
    async exec(command, execOptions = {}) {
      calls.push({ command, options: execOptions })

      if (/^\s*pwd -P\s*$/.test(command)) {
        return { stdout: `${cwd}\n`, stderr: "", exitCode: 0 }
      }

      if (command.includes("readlink -f") || command.includes("realpath")) {
        const match = command.match(/if \[ -e ([^\s]+) \]/)
        const quoted = match?.[1] ?? ""
        const target = quoted.replace(/^'|'$/g, "").replace(/^"|"$/g, "")
        if (hasFs) {
          if (!fs.has(path.posix.normalize(target))) {
            return { stdout: "__MISSING__\n", stderr: "", exitCode: 0 }
          }
          return { stdout: `${resolve(target)}\n`, stderr: "", exitCode: 0 }
        }
        const mapped = Object.prototype.hasOwnProperty.call(realpaths, target)
          ? realpaths[target]
          : target
        if (mapped === null) {
          return { stdout: "__MISSING__\n", stderr: "", exitCode: 0 }
        }
        return { stdout: `${mapped ?? target}\n`, stderr: "", exitCode: 0 }
      }

      if (options.exec) {
        return options.exec({ command, options: execOptions })
      }

      return { stdout: "", stderr: "", exitCode: 0 }
    },
    async withSftp<T>(fn: (sftp: any) => Promise<T>): Promise<T> {
      if (!hasFs) {
        // Preserve the old stub for tests that predate the filesystem: no
        // realpath, so `sftpMatchesShell` fails and the shell path is used.
        return fn({ end: () => {}, fastGet: async () => {}, fastPut: async () => {} })
      }
      return fn(sftpSession)
    },
    async close() {},
  }
}
