import { Client, type SFTPWrapper } from "ssh2"
import { readFileSync } from "fs"
import type { RemoteConfig } from "./config.js"
import { quoteShell } from "./shell-quote.js"
import {
  checkHostKey,
  mismatchMessage,
  recordHostKey,
  unknownHostMessage,
} from "./known-hosts.js"

export interface ExecOptions {
  cwd?: string
  timeout?: number
  /**
   * Re-run the command once if the connection drops mid-flight. Default
   * false: a command that partially executed before the drop would run
   * again, which is unsafe for anything non-idempotent (review F-3).
   * Internal idempotent probes (realpath, stat, uname) may opt in.
   */
  retry?: boolean
  /** Cap on captured stdout+stderr bytes; output beyond this is dropped and marked. */
  maxOutputBytes?: number
}

export interface SSHPool {
  exec(command: string, options?: ExecOptions): Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>
  withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T>
  /**
   * Run a command and hand the caller its raw stdio streams. Needed for bulk
   * transfer, where piping a tar stream avoids one SFTP round trip per file
   * (review P-8). The caller must consume or destroy the streams.
   */
  execStream(
    command: string,
    options?: { timeout?: number }
  ): Promise<{
    stdout: NodeJS.ReadableStream
    stdin: NodeJS.WritableStream
    done: Promise<{ exitCode: number; stderr: string }>
  }>
  close(): Promise<void>
}

const HEALTH_CHECK_INTERVAL_MS = 30_000
const HEALTH_CHECK_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 500
const CONNECTION_RETRY_DELAY_MS = 5_000
/** 4 MB: comfortably above the MCP client's result limit, well below anything that hurts. */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Accumulates Buffer chunks up to a byte cap; decodes once, so UTF-8 is never split. */
export class BoundedBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private truncated = false
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    if (this.truncated) return
    const room = this.cap - this.bytes
    if (chunk.length <= room) {
      this.chunks.push(chunk)
      this.bytes += chunk.length
      return
    }
    if (room > 0) this.chunks.push(chunk.subarray(0, room))
    this.bytes = this.cap
    this.truncated = true
  }
  toString(): string {
    const text = Buffer.concat(this.chunks).toString("utf-8")
    return this.truncated
      ? `${text}\n[output truncated at ${this.cap} bytes]`
      : text
  }
}

/*
 * ConnectionPool, createSSHPool and execOnPool were removed in v3.0.0.
 * Replaced by src/ssh-connection.ts: one connection per target with
 * channel-based concurrency (review P-1, decision D-A). Measured on this
 * network: NAS connect 3597ms -> 400ms, genie 462ms -> 116ms, and five
 * remote sshd processes per target became one.
 *
 * This file now holds the shared types and helpers both layers use.
 */

export function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.error(
      `[SSH] Ignoring ${name}="${raw}" (expected an integer ${min}-${max}); using ${fallback}.`
    )
    return fallback
  }
  return parsed
}

export function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotconn") ||
    msg.includes("broken pipe") ||
    msg.includes("no response from server") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("network") ||
    msg.includes("disconnected")
  )
}

/**
 * Build ssh2 algorithms config from OpenSSH -o options.
 * CentOS 6 and other legacy systems need ssh-rsa (SHA-1) enabled.
 */
export function buildAlgorithms(extraOptions: string[]): any {
  const serverHostKey = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
  ]

  for (const opt of extraOptions) {
    const { key, value } = parseOpenSshOption(opt)
    if (key.toLowerCase() === "hostkeyalgorithms") {
      if (value.startsWith("+")) {
        const algo = value.slice(1)
        if (!serverHostKey.includes(algo)) {
          serverHostKey.push(algo)
        }
      } else {
        // Replace entire list
        return { serverHostKey: value.split(",") }
      }
    }
  }

  return { serverHostKey }
}

/** Read the algorithm name from an SSH public key blob: 4-byte length, then the name. */
export function detectKeyType(key: Buffer): string {
  try {
    const len = key.readUInt32BE(0)
    return key.subarray(4, 4 + len).toString("ascii")
  } catch {
    return "ssh-ed25519"
  }
}

export function parseOpenSshOption(option: string): { key: string; value: string } {
  const eq = option.indexOf("=")
  if (eq === -1) {
    return { key: option, value: "" }
  }
  return {
    key: option.slice(0, eq).trim(),
    value: option.slice(eq + 1).trim(),
  }
}

/**
 * ssh2 and child_process both report termination as (code, signal). A process
 * killed by a signal has no exit code, and `code ?? 0` turned that into a
 * reported success (review F-35), including for commands killed on timeout.
 */
export function exitCodeFrom(code: number | null | undefined, signal?: string | null): number {
  if (typeof code === "number") return code
  return signal ? -1 : 0
}

export function appendSignal(stderr: string, signal?: string | null): string {
  if (!signal) return stderr
  const note = `[terminated by signal ${signal}]`
  return stderr ? `${stderr}\n${note}` : note
}
