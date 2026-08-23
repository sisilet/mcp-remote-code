import fs from "fs/promises"
import type { RemoteConfig } from "./config.js"
import { buildRemoteConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { quoteShell } from "./shell-quote.js"
import { createSSHPool, type SSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"

export interface Connection {
  name: string
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
  host: string
  user: string
  port: number
  workdir: string
  platform: string
  isGitRepo: boolean
  connected: boolean
}

export class ConnectionManager {
  private connections = new Map<string, Connection>()

  async connect(
    name: string,
    sshCommand: string,
    root: string,
    password?: string,
    sudoPassword?: string
  ): Promise<ConnectionInfo> {
    if (this.connections.has(name)) {
      throw new Error(`Target "${name}" is already connected.`)
    }

    const config = buildRemoteConfig(sshCommand, root, { password, sudoPassword })
    const pathMapper = new PathMapper(config)
    const manifest = new ManifestManager(pathMapper)
    await manifest.load()

    const sshPool = await createSSHPool(config)
    const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

    try {
      await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
    } catch {}
    await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => {})

    ;(manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

    let remotePlatform = "linux"
    let isGitRepo = false
    try {
      const uname = await sshPool.exec("uname -s", { timeout: 5_000 })
      remotePlatform = uname.stdout.trim().toLowerCase()
    } catch {}
    try {
      const gitCheck = await sshPool.exec(
        `git -C ${quoteShell(root)} rev-parse --git-dir 2>/dev/null`,
        { timeout: 5_000 }
      )
      isGitRepo = gitCheck.exitCode === 0
    } catch {}

    this.connections.set(name, {
      name,
      config,
      sshPool,
      pathMapper,
      manifest,
      syncEngine,
      remotePlatform,
      isGitRepo,
    })

    return this.toInfo(name, config, remotePlatform, isGitRepo)
  }

  async connectAll(
    startups: Array<{
      name: string
      sshCommand: string
      root: string
      password?: string
      sudoPassword?: string
    }>
  ): Promise<ConnectionInfo[]> {
    const infos: ConnectionInfo[] = []
    for (const startup of startups) {
      infos.push(
        await this.connect(
          startup.name,
          startup.sshCommand,
          startup.root,
          startup.password,
          startup.sudoPassword
        )
      )
    }
    return infos
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
      this.toInfo(conn.name, conn.config, conn.remotePlatform, conn.isGitRepo)
    )
  }

  targetNames(): string[] {
    return Array.from(this.connections.keys())
  }

  /** Test-only: inject a prebuilt connection without SSH handshake. */
  setConnectionForTest(connection: Connection): void {
    this.connections.set(connection.name, connection)
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.manifest.save()
      await conn.sshPool.close()
    }
    this.connections.clear()
  }

  private toInfo(
    name: string,
    config: RemoteConfig,
    platform: string,
    isGitRepo: boolean
  ): ConnectionInfo {
    return {
      name,
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
