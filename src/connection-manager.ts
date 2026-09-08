import fs from "fs/promises"
import type { RemoteConfig, StartupConnection } from "./config.js"
import { buildLocalConfig, buildRemoteConfig } from "./config.js"
import { createLocalPool } from "./local-pool.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { quoteShell } from "./shell-quote.js"
import { type SSHPool } from "./ssh-pool.js"
import { createSSHConnection } from "./ssh-connection.js"
import { SyncEngine } from "./sync-engine.js"

/** Minimum time between reconnect attempts for an offline target. */
export const RETRY_COOLDOWN_MS = 15_000

export interface Connection {
  name: string
  transport?: "ssh" | "local"
  config: RemoteConfig
  sshPool: SSHPool
  pathMapper: PathMapper
  manifest: ManifestManager
  syncEngine: SyncEngine
  remotePlatform: string
  isGitRepo: boolean
}

export interface ConnectionInfo {
  name: string
  transport?: "ssh" | "local"
  host: string
  user: string
  port: number
  workdir: string
  platform: string
  isGitRepo: boolean
  connected: boolean
}

export interface FailedTarget {
  name: string
  error: string
}

interface FailedTargetState {
  error: string
  startup: StartupConnection
  lastAttempt: number
}

export interface ConnectAllResult {
  connected: ConnectionInfo[]
  failed: FailedTarget[]
}

export class ConnectionManager {
  private connections = new Map<string, Connection>()
  private failedTargets = new Map<string, FailedTargetState>()
  private retryInFlight = new Map<string, Promise<Connection | null>>()

  async connect(
    name: string,
    sshCommand: string,
    root: string,
    password?: string,
    sudoPassword?: string
  ): Promise<ConnectionInfo> {
    return this.connectStartup({
      name,
      type: "ssh",
      sshCommand,
      root,
      password,
      sudoPassword,
    })
  }

  async connectStartup(startup: StartupConnection): Promise<ConnectionInfo> {
    if (this.connections.has(startup.name)) {
      throw new Error(`Target "${startup.name}" is already connected.`)
    }

    if (startup.type === "local") {
      return this.connectLocal(startup.name, startup.root)
    }

    const config = buildRemoteConfig(startup.sshCommand, startup.root, {
      password: startup.password,
      sudoPassword: startup.sudoPassword,
      hostKeyPolicy: startup.hostKeyPolicy,
      connection: startup.connection,
    })
    ;(config as any).elicitation = startup.elicitation
    return this.finishConnect(startup.name, "ssh", config, await createSSHConnection(config))
  }

  private async connectLocal(name: string, root: string): Promise<ConnectionInfo> {
    const config = buildLocalConfig(root)
    try {
      const stats = await fs.stat(config.remoteWorkdir)
      if (!stats.isDirectory()) {
        throw new Error(`Local root is not a directory: ${config.remoteWorkdir}`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Local root does not exist: ${config.remoteWorkdir}`)
      }
      throw err
    }
    return this.finishConnect(name, "local", config, createLocalPool())
  }

  private async finishConnect(
    name: string,
    transport: "ssh" | "local",
    config: RemoteConfig,
    sshPool: SSHPool
  ): Promise<ConnectionInfo> {
    const pathMapper = new PathMapper(config)
    const manifest = new ManifestManager(pathMapper)
    await manifest.load()

    const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

    try {
      await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
    } catch {}
    await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => {})

    manifest.reset(pathMapper.remoteRoot)

    let remotePlatform: string = transport === "local" ? process.platform : "linux"
    let isGitRepo = false
    try {
      const uname = await sshPool.exec("uname -s", { retry: true, timeout: 5_000 })
      remotePlatform = uname.stdout.trim().toLowerCase()
    } catch {}
    try {
      const gitCheck = await sshPool.exec(
        `git -C ${quoteShell(config.remoteWorkdir)} rev-parse --git-dir 2>/dev/null`,
        { retry: true, timeout: 5_000 }
      )
      isGitRepo = gitCheck.exitCode === 0
    } catch {}

    this.failedTargets.delete(name)
    this.connections.set(name, {
      name,
      transport,
      config,
      sshPool,
      pathMapper,
      manifest,
      syncEngine,
      remotePlatform,
      isGitRepo,
    })

    return this.toInfo(name, transport, config, remotePlatform, isGitRepo)
  }

  async connectAll(startups: StartupConnection[]): Promise<ConnectAllResult> {
    this.failedTargets.clear()
    this.retryInFlight.clear()

    const settled = await Promise.allSettled(
      startups.map((startup) => this.connectStartup(startup))
    )

    const connected: ConnectionInfo[] = []
    const failed: FailedTarget[] = []

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]
      const startup = startups[i]
      if (result.status === "fulfilled") {
        connected.push(result.value)
        continue
      }
      const error =
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      this.recordFailure(startup, error)
      failed.push({ name: startup.name, error })
    }

    if (connected.length === 0) {
      const details = failed.map((f) => `- ${f.name}: ${f.error}`).join("\n")
      throw new Error(
        `No targets connected. ${failed.length} configured target(s) failed:\n${details}`
      )
    }

    return { connected, failed }
  }

  /**
   * Attempt to reconnect an offline target if the cooldown has elapsed.
   * Returns the connection on success, null if still offline / throttled / unknown.
   */
  async retryFailed(name: string): Promise<Connection | null> {
    const existing = this.connections.get(name)
    if (existing) return existing

    const state = this.failedTargets.get(name)
    if (!state) return null

    const inflight = this.retryInFlight.get(name)
    if (inflight) return inflight

    const elapsed = Date.now() - state.lastAttempt
    if (elapsed < RETRY_COOLDOWN_MS) {
      return null
    }

    const attempt = this.doRetryFailed(name, state).finally(() => {
      this.retryInFlight.delete(name)
    })
    this.retryInFlight.set(name, attempt)
    return attempt
  }

  private async doRetryFailed(
    name: string,
    state: FailedTargetState
  ): Promise<Connection | null> {
    state.lastAttempt = Date.now()
    try {
      // Drop any stale connection slot (should not exist) then reconnect from saved startup.
      this.connections.delete(name)
      await this.connectStartup(state.startup)
      return this.connections.get(name) ?? null
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.recordFailure(state.startup, error)
      return null
    }
  }

  private recordFailure(startup: StartupConnection, error: string): void {
    this.failedTargets.set(startup.name, {
      error,
      startup,
      lastAttempt: Date.now(),
    })
  }

  get(target?: string): Connection | undefined {
    if (target) {
      return this.connections.get(target)
    }
    if (this.connections.size === 1) {
      return this.connections.values().next().value
    }
    return undefined
  }

  list(): ConnectionInfo[] {
    return Array.from(this.connections.values()).map((conn) =>
      this.toInfo(
        conn.name,
        conn.transport ?? "ssh",
        conn.config,
        conn.remotePlatform,
        conn.isGitRepo
      )
    )
  }

  targetNames(): string[] {
    return Array.from(this.connections.keys())
  }

  failedTargetNames(): string[] {
    return Array.from(this.failedTargets.keys())
  }

  hasFailed(name: string): boolean {
    return this.failedTargets.has(name)
  }

  getFailedError(name: string): string | undefined {
    return this.failedTargets.get(name)?.error
  }

  getFailedRetryAfterMs(name: string): number | undefined {
    const state = this.failedTargets.get(name)
    if (!state) return undefined
    const remaining = RETRY_COOLDOWN_MS - (Date.now() - state.lastAttempt)
    return Math.max(0, remaining)
  }

  listFailed(): FailedTarget[] {
    return Array.from(this.failedTargets.entries()).map(([name, state]) => ({
      name,
      error: state.error,
    }))
  }

  /** Test-only: inject a prebuilt connection without SSH handshake. */
  setConnectionForTest(connection: Connection): void {
    this.connections.set(connection.name, connection)
  }

  /** Test-only: mark a target failed with a startup snapshot for retry tests. */
  setFailedForTest(startup: StartupConnection, error: string, lastAttempt = Date.now()): void {
    this.recordFailure(startup, error)
    const state = this.failedTargets.get(startup.name)
    if (state) state.lastAttempt = lastAttempt
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.manifest.save()
      await conn.sshPool.close()
    }
    this.connections.clear()
    this.failedTargets.clear()
    this.retryInFlight.clear()
  }

  private toInfo(
    name: string,
    transport: "ssh" | "local",
    config: RemoteConfig,
    platform: string,
    isGitRepo: boolean
  ): ConnectionInfo {
    return {
      name,
      transport,
      host: config.host,
      user: config.user,
      port: config.port,
      workdir: config.remoteWorkdir,
      platform,
      isGitRepo,
      connected: true,
    }
  }
}
