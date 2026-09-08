import fs from "fs/promises";
import { buildLocalConfig, buildRemoteConfig } from "./config.js";
import { createLocalPool } from "./local-pool.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { quoteShell } from "./shell-quote.js";
import { createSSHConnection } from "./ssh-connection.js";
import { SyncEngine } from "./sync-engine.js";
/** Minimum time between reconnect attempts for an offline target. */
export const RETRY_COOLDOWN_MS = 15_000;
export class ConnectionManager {
    connections = new Map();
    failedTargets = new Map();
    retryInFlight = new Map();
    async connect(name, sshCommand, root, password, sudoPassword) {
        return this.connectStartup({
            name,
            type: "ssh",
            sshCommand,
            root,
            password,
            sudoPassword,
        });
    }
    async connectStartup(startup) {
        if (this.connections.has(startup.name)) {
            throw new Error(`Target "${startup.name}" is already connected.`);
        }
        if (startup.type === "local") {
            return this.connectLocal(startup.name, startup.root);
        }
        const config = buildRemoteConfig(startup.sshCommand, startup.root, {
            password: startup.password,
            sudoPassword: startup.sudoPassword,
            hostKeyPolicy: startup.hostKeyPolicy,
            connection: startup.connection,
        });
        config.elicitation = startup.elicitation;
        return this.finishConnect(startup.name, "ssh", config, await createSSHConnection(config));
    }
    async connectLocal(name, root) {
        const config = buildLocalConfig(root);
        try {
            const stats = await fs.stat(config.remoteWorkdir);
            if (!stats.isDirectory()) {
                throw new Error(`Local root is not a directory: ${config.remoteWorkdir}`);
            }
        }
        catch (err) {
            if (err.code === "ENOENT") {
                throw new Error(`Local root does not exist: ${config.remoteWorkdir}`);
            }
            throw err;
        }
        return this.finishConnect(name, "local", config, createLocalPool());
    }
    async finishConnect(name, transport, config, sshPool) {
        const pathMapper = new PathMapper(config);
        const manifest = new ManifestManager(pathMapper);
        await manifest.load();
        const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool);
        try {
            await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true });
        }
        catch { }
        await fs.mkdir(pathMapper.mirrorBase, { recursive: true }).catch(() => { });
        manifest.reset(pathMapper.remoteRoot);
        let remotePlatform = transport === "local" ? process.platform : "linux";
        let isGitRepo = false;
        try {
            const uname = await sshPool.exec("uname -s", { retry: true, timeout: 5_000 });
            remotePlatform = uname.stdout.trim().toLowerCase();
        }
        catch { }
        try {
            const gitCheck = await sshPool.exec(`git -C ${quoteShell(config.remoteWorkdir)} rev-parse --git-dir 2>/dev/null`, { retry: true, timeout: 5_000 });
            isGitRepo = gitCheck.exitCode === 0;
        }
        catch { }
        this.failedTargets.delete(name);
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
        });
        return this.toInfo(name, transport, config, remotePlatform, isGitRepo);
    }
    async connectAll(startups) {
        this.failedTargets.clear();
        this.retryInFlight.clear();
        const settled = await Promise.allSettled(startups.map((startup) => this.connectStartup(startup)));
        const connected = [];
        const failed = [];
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const startup = startups[i];
            if (result.status === "fulfilled") {
                connected.push(result.value);
                continue;
            }
            const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
            this.recordFailure(startup, error);
            failed.push({ name: startup.name, error });
        }
        if (connected.length === 0) {
            const details = failed.map((f) => `- ${f.name}: ${f.error}`).join("\n");
            throw new Error(`No targets connected. ${failed.length} configured target(s) failed:\n${details}`);
        }
        return { connected, failed };
    }
    /**
     * Attempt to reconnect an offline target if the cooldown has elapsed.
     * Returns the connection on success, null if still offline / throttled / unknown.
     */
    async retryFailed(name) {
        const existing = this.connections.get(name);
        if (existing)
            return existing;
        const state = this.failedTargets.get(name);
        if (!state)
            return null;
        const inflight = this.retryInFlight.get(name);
        if (inflight)
            return inflight;
        const elapsed = Date.now() - state.lastAttempt;
        if (elapsed < RETRY_COOLDOWN_MS) {
            return null;
        }
        const attempt = this.doRetryFailed(name, state).finally(() => {
            this.retryInFlight.delete(name);
        });
        this.retryInFlight.set(name, attempt);
        return attempt;
    }
    async doRetryFailed(name, state) {
        state.lastAttempt = Date.now();
        try {
            // Drop any stale connection slot (should not exist) then reconnect from saved startup.
            this.connections.delete(name);
            await this.connectStartup(state.startup);
            return this.connections.get(name) ?? null;
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.recordFailure(state.startup, error);
            return null;
        }
    }
    recordFailure(startup, error) {
        this.failedTargets.set(startup.name, {
            error,
            startup,
            lastAttempt: Date.now(),
        });
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
        return Array.from(this.connections.values()).map((conn) => this.toInfo(conn.name, conn.transport ?? "ssh", conn.config, conn.remotePlatform, conn.isGitRepo));
    }
    targetNames() {
        return Array.from(this.connections.keys());
    }
    failedTargetNames() {
        return Array.from(this.failedTargets.keys());
    }
    hasFailed(name) {
        return this.failedTargets.has(name);
    }
    getFailedError(name) {
        return this.failedTargets.get(name)?.error;
    }
    getFailedRetryAfterMs(name) {
        const state = this.failedTargets.get(name);
        if (!state)
            return undefined;
        const remaining = RETRY_COOLDOWN_MS - (Date.now() - state.lastAttempt);
        return Math.max(0, remaining);
    }
    listFailed() {
        return Array.from(this.failedTargets.entries()).map(([name, state]) => ({
            name,
            error: state.error,
        }));
    }
    /** Test-only: inject a prebuilt connection without SSH handshake. */
    setConnectionForTest(connection) {
        this.connections.set(connection.name, connection);
    }
    /** Test-only: mark a target failed with a startup snapshot for retry tests. */
    setFailedForTest(startup, error, lastAttempt = Date.now()) {
        this.recordFailure(startup, error);
        const state = this.failedTargets.get(startup.name);
        if (state)
            state.lastAttempt = lastAttempt;
    }
    async close() {
        for (const conn of this.connections.values()) {
            await conn.manifest.save();
            await conn.sshPool.close();
        }
        this.connections.clear();
        this.failedTargets.clear();
        this.retryInFlight.clear();
    }
    toInfo(name, transport, config, platform, isGitRepo) {
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
        };
    }
}
//# sourceMappingURL=connection-manager.js.map