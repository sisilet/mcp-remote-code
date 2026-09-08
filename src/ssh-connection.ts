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
// Re-exported for tests: these encode the (code, signal) contract.
export { exitCodeFrom, appendSignal } from "./ssh-pool.js"
import {
  BoundedBuffer,
  DEFAULT_MAX_OUTPUT_BYTES,
  buildAlgorithms,
  detectKeyType,
  intFromEnv,
  exitCodeFrom,
  appendSignal,
  isConnectionError,
  parseOpenSshOption,
  type ExecOptions,
  type SSHPool,
} from "./ssh-pool.js"

/**
 * One SSH connection per target, concurrency via channels (review P-1, D-A).
 *
 * Replaces the previous 3+2 connection pool. SSH multiplexes channels over a
 * single transport by design; that is how OpenSSH's ControlMaster works. A
 * connection pool is a database pattern: it exists because a DB connection is
 * single-threaded, which an SSH connection is not.
 *
 * What this buys, measured on this network: five handshakes become one, and
 * five remote sshd processes become one. On the DS220j each sshd costs 10 to
 * 16 MB against roughly 150 MB free, so the old design spent ~60 MB of the
 * NAS's memory simply by being connected.
 *
 * It also deletes machinery rather than adding it: no replenisher, no
 * exec-based health pings, no busy set, no wait queue. Transport liveness is
 * ssh2's keepalive, which was already configured and already doing the job.
 */

const CONNECT_TIMEOUT_MS = 30_000
/**
 * Concurrent channels. OpenSSH's default MaxSessions is 10 and it counts
 * sftp sessions too, so leave headroom: exceeding it yields
 * "Channel open failure: open failed", observed against genie at 12.
 */
const DEFAULT_MAX_CHANNELS = 6

/**
 * Injection point for tests. The lifecycle paths that matter here — reconnect
 * races, a transport dying with callers queued, a timeout landing before the
 * channel opens — are unreachable from a test that needs a real SSH server,
 * which is why they carried three defects at once (review F-31, F-32, F-34).
 */
export interface SSHConnectionDeps {
  connect?: (config: RemoteConfig) => Promise<Client>
}

export async function createSSHConnection(
  config: RemoteConfig,
  deps: SSHConnectionDeps = {}
): Promise<SSHPool> {
  warnOnDeprecatedPoolEnv()
  const maxChannels = intFromEnv("REMOTE_MAX_CHANNELS", DEFAULT_MAX_CHANNELS, 1, 32)
  const openConnection = deps.connect ?? connect

  let client: Client | undefined = await openConnection(config)
  let closed = false

  // Simple semaphore: SSH servers cap concurrent sessions per connection
  // (MaxSessions), so opening channels without limit fails once past it.
  let inFlight = 0
  const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = []

  // Persistent SFTP session, opened on first use and reused thereafter.
  let sharedSftp: SFTPWrapper | undefined
  // In-flight reconnect, shared by every caller that finds the client gone.
  let connecting: Promise<Client> | undefined
  let sftpQueue: Promise<void> = Promise.resolve()
  /**
   * Set once a server proves it has no SFTP subsystem (DSM ships with SFTP
   * off by default, for example). Without this the tool retries a
   * permanently-unavailable subsystem on every file operation, leaking a
   * half-open channel each time until MaxSessions is exhausted and the
   * connection dies with "Channel open failure".
   */
  let sftpUnavailable = false

  async function getSftp(): Promise<SFTPWrapper> {
    if (sftpUnavailable) throw new Error("SFTP subsystem unavailable on this server")
    if (sharedSftp) return sharedSftp
    const c = await ensureClient()
    sharedSftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      c.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          if (/unable to start subsystem/i.test(err.message)) {
            sftpUnavailable = true
            console.error(
              `[SSH] ${config.host}: no SFTP subsystem; file transfers will use the ` +
              `shell instead. Enable SFTP on the server for better performance.`
            )
          }
          reject(err)
          return
        }
        // Unhandled 'error' on an SFTP session is a fatal uncaught exception.
        sftp.on("error", () => { sharedSftp = undefined })
        sftp.on("close", () => { sharedSftp = undefined })
        resolve(sftp)
      })
    })
    return sharedSftp
  }

  async function acquireChannel(): Promise<void> {
    if (closed) throw new Error("SSH connection closed")
    if (inFlight < maxChannels) {
      inFlight++
      return
    }
    // Wait for a slot to be handed over. The slot is transferred by
    // releaseChannel without ever dropping the count, so no other caller can
    // slip through the fast path in between.
    await new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    if (closed) {
      // Hand the inherited slot to the next waiter rather than losing it.
      releaseChannel()
      throw new Error("SSH connection closed")
    }
  }
  function releaseChannel(): void {
    // Hand the slot straight to a waiter, keeping the count unchanged. The
    // obvious version (decrement, then wake a waiter that increments) lets a
    // new caller pass the `inFlight < maxChannels` check in the gap, so the
    // cap is exceeded and the server answers "Channel open failure". A unit
    // test drove the count to 6 against a cap of 2 that way.
    const next = waiters.shift()
    if (next) {
      next.resolve()
      return
    }
    // Never drift below zero: an inflated count wedges every later caller.
    if (inFlight > 0) inFlight--
  }

  /**
   * Run fn holding exactly one channel slot. Acquire and release are paired
   * here rather than at call sites: an earlier version released inside a
   * retry branch AND in `finally`, so the count drifted, `inFlight` stuck
   * above the cap, and every later acquire queued a waiter that never
   * resolved. Symptom: the whole server hung on all targets, and the test
   * runner reported "Promise resolution is still pending".
   */
  async function withChannel<T>(fn: () => Promise<T>): Promise<T> {
    await acquireChannel()
    try {
      return await fn()
    } finally {
      releaseChannel()
    }
  }

  /**
   * Fail every queued waiter. Called when the transport goes away, not only
   * from close(): a caller that simply stops using the connection would
   * otherwise leave waiters pending forever, which surfaces as "Promise
   * resolution is still pending but the event loop has already resolved"
   * and, in the server, as a hang.
   *
   * They are rejected, not resolved (review F-32). The earlier version reset
   * `inFlight` to zero and resolved everyone, so N waiters resumed believing
   * they each held a slot while the operations still running also held
   * theirs. Each of those later released against a count that no longer
   * described reality, the count drifted permanently low, and the cap that
   * keeps the server under MaxSessions stopped applying. Slots belonging to
   * running operations are returned by their own `finally`, so the count
   * must be left alone here.
   */
  function failWaiters(err: Error): void {
    for (const waiter of waiters.splice(0)) waiter.reject(err)
  }

  /**
   * The current transport, reconnecting if it died.
   *
   * Single-flight (review F-31): without it, every caller queued behind a
   * dead transport called connect() at once, each overwrote `client`, and
   * every connection but the last was leaked — a live socket locally and an
   * sshd process remotely, which is precisely the cost this design exists to
   * avoid. Concurrent callers now share one attempt.
   */
  async function ensureClient(): Promise<Client> {
    if (closed) throw new Error("SSH connection closed")
    if (client) return client
    if (!connecting) {
      connecting = openConnection(config)
        .then((c) => {
          if (closed) {
            try { c.end() } catch {}
            throw new Error("SSH connection closed")
          }
          // Should not happen with single-flight, but never strand a
          // transport: ending it is the whole point.
          if (client && client !== c) {
            try { (client as Client).end() } catch {}
          }
          client = c
          adopt(c)
          return c
        })
        .finally(() => {
          connecting = undefined
        })
    }
    return connecting
  }

  /**
   * Drop the current transport. Both halves must go at once (review F-40):
   * clearing `client` while leaving `sharedSftp` in place let a concurrent
   * withSftp keep using a session on a dead connection until the close event
   * happened to arrive.
   */
  function dropTransport(): void {
    try { (sharedSftp as any)?.end() } catch {}
    sharedSftp = undefined
    try { client?.end() } catch {}
    client = undefined
  }

  /**
   * Attach lifecycle handling to a freshly connected client. When the
   * transport ends, any caller queued for a channel must be failed and the
   * SFTP session dropped, otherwise those promises never settle.
   */
  function adopt(c: Client): void {
    const onGone = () => {
      if (client === c) {
        client = undefined
        sharedSftp = undefined
      }
      failWaiters(new Error("SSH transport closed"))
    }
    c.on("close", onGone)
    c.on("end", onGone)
  }

  adopt(client)

  return {
    async exec(command: string, options: ExecOptions = {}) {
      let shellCommand = command
      let stdin: string | undefined
      if (options.cwd) {
        shellCommand = `cd ${quoteShell(options.cwd)} && ${command}`
      }
      if (config.sudoPassword && /^\s*sudo\s/.test(shellCommand)) {
        shellCommand = shellCommand.replace(/^(\s*)sudo\s/, "$1sudo -S -p '' ")
        stdin = `${config.sudoPassword}\n`
      }

      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

      return execWithRetry(
        () =>
          withChannel(async () => {
            const c = await ensureClient()
            return execOnChannel(c, shellCommand, options.timeout, stdin, maxOutputBytes)
          }),
        {
          retry: options.retry,
          // The transport is gone; drop it so the next call reconnects.
          onConnectionError: dropTransport,
        }
      )
    },

    async execStream(command: string, options: { timeout?: number } = {}) {
      await acquireChannel()
      // One release per acquire, whichever way this ends: a failed client, the
      // exec callback erroring, the stream closing, or the timeout firing.
      let released = false
      const releaseOnce = () => {
        if (released) return
        released = true
        releaseChannel()
      }
      let c: Client
      try {
        c = await ensureClient()
      } catch (err) {
        releaseOnce()
        throw err
      }
      return new Promise<any>((resolve, reject) => {
        c.exec(command, (err: Error | undefined, stream: any) => {
          if (err) {
            releaseOnce()
            reject(err)
            return
          }
          const errBuf = new BoundedBuffer(64 * 1024)
          stream.stderr.on("data", (d: Buffer) => errBuf.push(d))

          // An ssh2 channel stalls if its readable side is never consumed:
          // the window fills, the remote blocks on write, and the channel
          // never closes. Callers that pipe stdout elsewhere handle it; for
          // those that do not (a push, where the remote only reports status),
          // drain it here so the channel can complete. Observed as a hang
          // where the files transferred correctly but the call never returned.
          let stdoutConsumed = false
          queueMicrotask(() => {
            if (!stdoutConsumed) stream.resume()
          })

          const done = new Promise<{ exitCode: number; stderr: string }>((res) => {
            let settled = false
            const finish = (exitCode: number, stderr: string) => {
              if (settled) return
              settled = true
              if (timer) clearTimeout(timer)
              releaseOnce()
              res({ exitCode, stderr })
            }
            const timer = options.timeout
              ? setTimeout(() => {
                  killStream(stream)
                  finish(-1, `timeout after ${options.timeout}ms`)
                }, options.timeout)
              : undefined
            stream.on("close", (code: number | null, signal?: string) =>
              finish(exitCodeFrom(code, signal), appendSignal(errBuf.toString(), signal))
            )
            // Without this, an errored stream never closes, `done` never
            // settles, and the slot is never returned.
            stream.on("error", (e: Error) => finish(-1, e.message))
          })

          resolve({
            // Mark consumption when the caller takes the readable side, so
            // the auto-drain above does not steal their data.
            get stdout() {
              stdoutConsumed = true
              return stream
            },
            stdin: stream,
            done,
          })
        })
      })
    },

    async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
      // One long-lived SFTP session per connection, not one per call (P-7,
      // plan item 2.4). Opening and closing a session per operation churns
      // channels; on a slow server teardown lags the open rate, sessions
      // accumulate past MaxSessions, and the channel open fails. Observed
      // against the DS220j during 20 rapid path resolutions.
      //
      // Calls are serialised on the shared session because SFTP requests on
      // one channel are ordered anyway, and a single session avoids the churn
      // entirely.
      const run = async (): Promise<T> => {
        const sftp = await getSftp()
        try {
          return await fn(sftp)
        } catch (err) {
          // A failed session is not reusable; drop it so the next call reopens.
          if (isChannelOpenFailure(err as Error) || isConnectionError(err as Error)) {
            sharedSftp = undefined
            try { (sftp as any).end() } catch {}
          }
          throw err
        }
      }
      // Serialise: chain onto the previous call so only one runs at a time.
      const result = sftpQueue.then(run, run)
      sftpQueue = result.then(() => undefined, () => undefined)
      return result
    },

    async close() {
      closed = true
      // Settle anyone queued for a channel. Without this, a waiter promise
      // stays pending after the connection is gone, the event loop drains,
      // and the process reports "Promise resolution is still pending" (or,
      // in the server, simply never answers).
      inFlight = 0
      failWaiters(new Error("SSH connection closed"))
      dropTransport()
    },
  }
}

export function isChannelOpenFailure(err: Error): boolean {
  return /channel open failure/i.test(err.message)
}

function killStream(stream: any): void {
  try { stream.signal?.("KILL") } catch {}
  try { stream.close?.() } catch {}
  try { stream.destroy?.() } catch {}
}


/** Total attempts for a command the caller has declared idempotent. */
const MAX_CONNECTION_ATTEMPTS = 3
/** Total attempts when the server refuses the channel. */
const MAX_CHANNEL_OPEN_ATTEMPTS = 3

/**
 * Run `attempt`, retrying only where retrying cannot change what the remote
 * did (review F-3, and F-26 for the half-fix).
 *
 * Two failures look similar and are not:
 *
 *  - A refused channel (MaxSessions contention) means the command never
 *    started. Re-running it is always safe, whatever the caller asked for.
 *  - A transport that dies mid-command means the command may have run,
 *    partly or fully. Re-running `mv`, `rm` or `>>` then applies it twice.
 *    Only the caller knows whether that is acceptable, so this is gated on
 *    an explicit `retry: true`. `remote_bash` passes `retry: false` and must
 *    get exactly one execution.
 *
 * `onConnectionError` fires whether or not the call will be retried, because
 * the dead transport has to be dropped either way.
 */
export async function execWithRetry<T>(
  attempt: () => Promise<T>,
  options: {
    retry?: boolean
    onConnectionError?: (err: Error) => void
    delay?: (ms: number) => Promise<void>
  } = {}
): Promise<T> {
  const delay = options.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let channelOpenAttempts = 0
  let connectionAttempts = 0

  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      const error = err as Error
      if ((error as any).isTimeout) throw error

      if (isChannelOpenFailure(error)) {
        channelOpenAttempts++
        if (channelOpenAttempts >= MAX_CHANNEL_OPEN_ATTEMPTS) throw error
        // Back off outside the slot so the queue can drain.
        await delay(100 + (channelOpenAttempts - 1) * 200)
        continue
      }

      if (isConnectionError(error)) {
        options.onConnectionError?.(error)
        connectionAttempts++
        if (options.retry !== true || connectionAttempts >= MAX_CONNECTION_ATTEMPTS) throw error
        continue
      }

      throw error
    }
  }
}

function warnOnDeprecatedPoolEnv(): void {
  for (const name of ["REMOTE_POOL_COMMAND_SIZE", "REMOTE_POOL_FILE_SIZE", "REMOTE_POOL_STAGGER_MS"]) {
    if (process.env[name]) {
      console.error(
        `[SSH] ${name} is obsolete: there is now one connection per target with ` +
        `channel-based concurrency. Use REMOTE_MAX_CHANNELS instead.`
      )
    }
  }
}

function connect(config: RemoteConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let resolved = false
    let hostKeyError: Error | undefined

    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      client.end()
      reject(new Error(`SSH connection timeout after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)

    const connConfig: any = {
      host: config.host,
      port: config.port,
      username: config.user,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      algorithms: buildAlgorithms(config.extraOptions),
    }

    let policy = config.hostKeyPolicy ?? "verify"
    for (const opt of config.extraOptions) {
      const { key, value } = parseOpenSshOption(opt)
      if (key.toLowerCase() === "stricthostkeychecking") {
        const v = value.toLowerCase()
        if (v === "no" || v === "off") policy = "insecure"
        else if (v === "accept-new") policy = "accept-new"
      }
    }

    if (policy === "insecure") {
      console.error(
        `[SSH] WARNING: host key verification disabled for ${config.host}:${config.port}.`
      )
      connConfig.hostVerifier = () => true
    } else {
      connConfig.hostVerifier = (key: Buffer) => {
        const result = checkHostKey(config.host, config.port, key)
        if (result.ok) return true
        if (result.mismatch) {
          hostKeyError = new Error(mismatchMessage(config.host, config.port, result.fingerprint))
          return false
        }
        if (policy === "accept-new") {
          try {
            recordHostKey(config.host, config.port, key, detectKeyType(key))
            console.error(
              `[SSH] Recorded new host key for ${config.host}:${config.port} (${result.fingerprint})`
            )
            return true
          } catch (err) {
            hostKeyError = new Error(`Could not record host key: ${(err as Error).message}`)
            return false
          }
        }
        hostKeyError = new Error(unknownHostMessage(config.host, config.port, result.fingerprint))
        return false
      }
    }

    if (config.identity) {
      connConfig.privateKey = readFileSync(config.identity)
      if (config.passphrase) connConfig.passphrase = config.passphrase
    } else if (config.password) {
      connConfig.password = config.password
    }

    client
      .on("ready", () => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        // Post-ready errors (channel failures, transport drops) arrive as
        // events. Without a listener Node treats them as fatal, so log and
        // let the per-call retry logic decide what to do.
        client.on("error", (e: Error) => {
          console.error(`[SSH] ${config.host}:${config.port} error: ${e.message}`)
        })
        resolve(client)
      })
      .on("error", (err: Error) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        reject(hostKeyError ?? err)
      })
      .connect(connConfig)
  })
}

function execOnChannel(
  client: Client,
  command: string,
  timeoutMs: number | undefined,
  stdin: string | undefined,
  maxOutputBytes: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const outBuf = new BoundedBuffer(maxOutputBytes)
    const errBuf = new BoundedBuffer(maxOutputBytes)
    let killed = false
    let activeStream: any

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            if (killed) return
            killed = true
            // If the channel has not opened yet the stream arrives after this
            // point; the exec callback below kills it then (review F-34).
            if (activeStream) killStream(activeStream)
            const err: any = new Error(`Remote Code: SSH exec timeout after ${timeoutMs}ms`)
            err.isTimeout = true
            reject(err)
          }, timeoutMs)
        : undefined

    client.exec(command, (err: Error | undefined, stream: any) => {
      if (err) {
        if (timer) clearTimeout(timer)
        reject(err)
        return
      }
      activeStream = stream
      if (killed) {
        // The timeout fired while the channel was still opening. Nothing is
        // waiting on this stream any more, and the earlier version simply
        // walked away from it: the remote command ran to completion with the
        // local side no longer counting the channel.
        killStream(stream)
        return
      }
      stream.on("data", (d: Buffer) => outBuf.push(d))
      stream.stderr.on("data", (d: Buffer) => errBuf.push(d))
      stream.on("close", (code: number | null, signal?: string) => {
        if (timer) clearTimeout(timer)
        if (killed) return
        resolve({
          stdout: outBuf.toString(),
          stderr: appendSignal(errBuf.toString(), signal),
          exitCode: exitCodeFrom(code, signal),
        })
      })
      stream.on("error", (e: Error) => {
        if (timer) clearTimeout(timer)
        if (killed) return
        reject(e)
      })
      if (stdin !== undefined) stream.end(stdin)
    })
  })
}
