import fs from "fs/promises";
import { buildRemoteConfig } from "./config.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { quoteShell } from "./shell-quote.js";
import { createSSHPool } from "./ssh-pool.js";
import { SyncEngine } from "./sync-engine.js";
export class ConnectionManager {
    connections = new Map();
    async connect(name, sshCommand, root, password, sudoPassword) {
        if (this.connections.has(name)) {
            throw new Error(`Target "${name}" is already connected.`);
        }
        const config = buildRemoteConfig(sshCommand, root, { password, sudoPassword });
        const pathMapper = new PathMapper(config);
        const manifest = new ManifestManager(pathMapper);
        await manifest.load();
        const sshPool = await createSSHPool(config);
        const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool);
        try {
            await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true });
        }
        catch { }
        await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => { });
        manifest.manifest = { remote_root: pathMapper.remoteRoot, files: {} };
        let remotePlatform = "linux";
        let isGitRepo = false;
        try {
            const uname = await sshPool.exec("uname -s", { timeout: 5_000 });
            remotePlatform = uname.stdout.trim().toLowerCase();
        }
        catch { }
        try {
            const gitCheck = await sshPool.exec(`git -C ${quoteShell(root)} rev-parse --git-dir 2>/dev/null`, { timeout: 5_000 });
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
        return this.toInfo(name, config, remotePlatform, isGitRepo);
    }
    async connectAll(startups) {
        const infos = [];
        for (const startup of startups) {
            infos.push(await this.connect(startup.name, startup.sshCommand, startup.root, startup.password, startup.sudoPassword));
        }
        return infos;
    }
    get(target) {
        if (target) {
            return this.connections.get(target);
        }
        if (this.connections.size === 1) {
            return this.connections.values().next().value;
        }
        return undefined;
    }
    list() {
        return Array.from(this.connections.values()).map((conn) => this.toInfo(conn.name, conn.config, conn.remotePlatform, conn.isGitRepo));
    }
    targetNames() {
        return Array.from(this.connections.keys());
    }
    /** Test-only: inject a prebuilt connection without SSH handshake. */
    setConnectionForTest(connection) {
        this.connections.set(connection.name, connection);
    }
    async close() {
        for (const conn of this.connections.values()) {
            await conn.manifest.save();
            await conn.sshPool.close();
        }
        this.connections.clear();
    }
    toInfo(name, config, platform, isGitRepo) {
        return {
            name,
            host: config.host,
            user: config.user,
            port: config.port,
            workdir: config.remoteWorkdir,
            platform,
            isGitRepo,
            connected: true,
        };
    }
}
//# sourceMappingURL=connection-manager.js.map