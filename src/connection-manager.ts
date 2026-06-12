import fs from "fs/promises"
import os from "os"
import path from "path"
import type { RemoteConfig } from "./config.js"
import { buildRemoteConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { quoteShell } from "./shell-quote.js"
import { createSSHPool, type SSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"

export interface MachineConfig {
  name: string
  sshCommand: string
  workdir: string
  password?: string
  sudoPassword?: string
  description?: string
}

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
  private configs = new Map<string, MachineConfig>()
  private configFilePath: string
  private readyPromise: Promise<void>

  constructor() {
    this.configFilePath = path.join(os.homedir(), ".opencode", "mcp-remote-code-configs.json")
    this.readyPromise = this.loadConfigs()
  }

  private async loadConfigs(): Promise<void> {
    try {
      const data = (await fs.readFile(this.configFilePath, "utf-8")).replace(/^\uFEFF/, "")
      const parsed = JSON.parse(data)
      const configs: MachineConfig[] = Array.isArray(parsed) ? parsed : [parsed]
      for (const config of configs) {
        this.configs.set(config.name, config)
      }
    } catch {
      // Config file doesn't exist yet, that's fine
    }
  }

  async ready(): Promise<void> {
    await this.readyPromise
  }

  private async saveConfigs(): Promise<void> {
    const configs = Array.from(this.configs.values())
    await fs.mkdir(path.dirname(this.configFilePath), { recursive: true })
    await fs.writeFile(this.configFilePath, JSON.stringify(configs, null, 2))
  }

  // Config management
  async addConfig(config: MachineConfig): Promise<void> {
    if (this.configs.has(config.name)) {
      throw new Error(`Config "${config.name}" already exists. Remove it first or use a different name.`)
    }
    if (!config.workdir) {
      throw new Error(`Workdir is required for config "${config.name}".`)
    }
    this.configs.set(config.name, config)
    await this.saveConfigs()
  }

  async removeConfig(name: string): Promise<void> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`Config "${name}" not found.`)
    }
    // If connected, disconnect first
    if (this.connections.has(name)) {
      await this.disconnect(name)
    }
    this.configs.delete(name)
    await this.saveConfigs()
  }

  getConfig(name: string): MachineConfig | undefined {
    return this.configs.get(name)
  }

  listConfigs(): Array<MachineConfig & { connected: boolean }> {
    return Array.from(this.configs.values()).map((config) => ({
      ...config,
      connected: this.connections.has(config.name),
    }))
  }

  // Connection management
  async connectFromConfig(name: string): Promise<ConnectionInfo> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`Config "${name}" not found. Use remote_add_config to add it first.`)
    }
    return this.connectWithParams(
      config.name,
      config.sshCommand,
      config.workdir,
      config.password,
      config.sudoPassword
    )
  }

  async connectWithParams(
    name: string,
    sshCommand: string,
    workdir: string,
    password?: string,
    sudoPassword?: string
  ): Promise<ConnectionInfo> {
    if (this.connections.has(name)) {
      throw new Error(`Connection "${name}" already exists. Use a different name or disconnect first.`)
    }

    if (!workdir) {
      throw new Error(`Workdir is required for connection "${name}".`)
    }

    const config = buildRemoteConfig(sshCommand, workdir, { password, sudoPassword })
    const pathMapper = new PathMapper(config)
    const manifest = new ManifestManager(pathMapper)
    await manifest.load()

    const sshPool = await createSSHPool(config)
    const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

    // Clean and recreate mirror base
    try {
      await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
    } catch {}
    await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => {})

    // Reset manifest
    ;(manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

    // Probe remote environment
    let remotePlatform = "linux"
    let isGitRepo = false
    try {
      const uname = await sshPool.exec("uname -s", { timeout: 5_000 })
      remotePlatform = uname.stdout.trim().toLowerCase()
    } catch {}
    try {
      const gitCheck = await sshPool.exec(
        `git -C ${quoteShell(workdir)} rev-parse --git-dir 2>/dev/null`,
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

    return {
      name,
      host: config.host,
      user: config.user,
      port: config.port,
      workdir,
      platform: remotePlatform,
      isGitRepo,
      connected: true,
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) {
      throw new Error(`Connection "${name}" not found.`)
    }

    await conn.manifest.save()
    await conn.sshPool.close()
    this.connections.delete(name)
  }

  get(name?: string): Connection | undefined {
    if (name) {
      return this.connections.get(name)
    }
    // If only one connection exists, return it as default
    if (this.connections.size === 1) {
      return this.connections.values().next().value
    }
    return undefined
  }

  list(): ConnectionInfo[] {
    return Array.from(this.connections.values()).map((conn) => ({
      name: conn.name,
      host: conn.config.host,
      user: conn.config.user,
      port: conn.config.port,
      workdir: conn.config.remoteWorkdir,
      platform: conn.remotePlatform,
      isGitRepo: conn.isGitRepo,
      connected: true,
    }))
  }

  async closeAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.manifest.save()
      await conn.sshPool.close()
    }
    this.connections.clear()
  }
}
