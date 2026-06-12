import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildRemoteConfig } from "./config.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { quoteShell } from "./shell-quote.js";
import { createSSHPool } from "./ssh-pool.js";
import { SyncEngine } from "./sync-engine.js";
export class ConnectionManager {
    connections = new Map();
    configs = new Map();
    configFilePath;
    readyPromise;
    constructor() {
        this.configFilePath = path.join(os.homedir(), ".opencode", "mcp-remote-code-configs.json");
        this.readyPromise = this.loadConfigs();
    }
    async loadConfigs() {
        try {
            const data = (await fs.readFile(this.configFilePath, "utf-8")).replace(/^\uFEFF/, "");
            const parsed = JSON.parse(data);
            const configs = Array.isArray(parsed) ? parsed : [parsed];
            for (const config of configs) {
                this.configs.set(config.name, config);
            }
        }
        catch {
            // Config file doesn't exist yet, that's fine
        }
    }
    async ready() {
        await this.readyPromise;
    }
    async saveConfigs() {
        const configs = Array.from(this.configs.values());
        await fs.mkdir(path.dirname(this.configFilePath), { recursive: true });
        await fs.writeFile(this.configFilePath, JSON.stringify(configs, null, 2));
    }
    // Config management
    async addConfig(config) {
        if (this.configs.has(config.name)) {
            throw new Error(`Config "${config.name}" already exists. Remove it first or use a different name.`);
        }
        if (!config.workdir) {
            throw new Error(`Workdir is required for config "${config.name}".`);
        }
        this.configs.set(config.name, config);
        await this.saveConfigs();
    }
    async removeConfig(name) {
        const config = this.configs.get(name);
        if (!config) {
            throw new Error(`Config "${name}" not found.`);
        }
        // If connected, disconnect first
        if (this.connections.has(name)) {
            await this.disconnect(name);
        }
        this.configs.delete(name);
        await this.saveConfigs();
    }
    getConfig(name) {
        return this.configs.get(name);
    }
    listConfigs() {
        return Array.from(this.configs.values()).map((config) => ({
            ...config,
            connected: this.connections.has(config.name),
        }));
    }
    // Connection management
    async connectFromConfig(name) {
        const config = this.configs.get(name);
        if (!config) {
            throw new Error(`Config "${name}" not found. Use remote_add_config to add it first.`);
        }
        return this.connectWithParams(config.name, config.sshCommand, config.workdir, config.password, config.sudoPassword);
    }
    async connectWithParams(name, sshCommand, workdir, password, sudoPassword) {
        if (this.connections.has(name)) {
            throw new Error(`Connection "${name}" already exists. Use a different name or disconnect first.`);
        }
        if (!workdir) {
            throw new Error(`Workdir is required for connection "${name}".`);
        }
        const config = buildRemoteConfig(sshCommand, workdir, { password, sudoPassword });
        const pathMapper = new PathMapper(config);
        const manifest = new ManifestManager(pathMapper);
        await manifest.load();
        const sshPool = await createSSHPool(config);
        const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool);
        // Clean and recreate mirror base
        try {
            await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true });
        }
        catch { }
        await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => { });
        manifest.manifest = { remote_root: pathMapper.remoteRoot, files: {} };
        // Probe remote environment
        let remotePlatform = "linux";
        let isGitRepo = false;
        try {
            const uname = await sshPool.exec("uname -s", { timeout: 5_000 });
            remotePlatform = uname.stdout.trim().toLowerCase();
        }
        catch { }
        try {
            const gitCheck = await sshPool.exec(`git -C ${quoteShell(workdir)} rev-parse --git-dir 2>/dev/null`, { timeout: 5_000 });
            isGitRepo = gitCheck.exitCode === 0;
        }
        catch { }
        this.connections.set(name, {
            name,
            config,
            sshPool,
            pathMapper,
            manifest,
            syncEngine,
            remotePlatform,
            isGitRepo,
        });
        return {
            name,
            host: config.host,
            user: config.user,
            port: config.port,
            workdir,
            platform: remotePlatform,
            isGitRepo,
            connected: true,
        };
    }
    async disconnect(name) {
        const conn = this.connections.get(name);
        if (!conn) {
            throw new Error(`Connection "${name}" not found.`);
        }
        await conn.manifest.save();
        await conn.sshPool.close();
        this.connections.delete(name);
    }
    get(name) {
        if (name) {
            return this.connections.get(name);
        }
        // If only one connection exists, return it as default
        if (this.connections.size === 1) {
            return this.connections.values().next().value;
        }
        return undefined;
    }
    list() {
        return Array.from(this.connections.values()).map((conn) => ({
            name: conn.name,
            host: conn.config.host,
            user: conn.config.user,
            port: conn.config.port,
            workdir: conn.config.remoteWorkdir,
            platform: conn.remotePlatform,
            isGitRepo: conn.isGitRepo,
            connected: true,
        }));
    }
    async closeAll() {
        for (const conn of this.connections.values()) {
            await conn.manifest.save();
            await conn.sshPool.close();
        }
        this.connections.clear();
    }
}
//# sourceMappingURL=connection-manager.js.map