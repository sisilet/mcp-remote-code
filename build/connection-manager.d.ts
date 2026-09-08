import type { RemoteConfig, StartupConnection } from "./config.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { type SSHPool } from "./ssh-pool.js";
import { SyncEngine } from "./sync-engine.js";
/** Minimum time between reconnect attempts for an offline target. */
export declare const RETRY_COOLDOWN_MS = 15000;
export interface Connection {
    name: string;
    transport?: "ssh" | "local";
    config: RemoteConfig;
    sshPool: SSHPool;
    pathMapper: PathMapper;
    manifest: ManifestManager;
    syncEngine: SyncEngine;
    remotePlatform: string;
    isGitRepo: boolean;
}
export interface ConnectionInfo {
    name: string;
    transport?: "ssh" | "local";
    host: string;
    user: string;
    port: number;
    workdir: string;
    platform: string;
    isGitRepo: boolean;
    connected: boolean;
}
export interface FailedTarget {
    name: string;
    error: string;
}
export interface ConnectAllResult {
    connected: ConnectionInfo[];
    failed: FailedTarget[];
}
export declare class ConnectionManager {
    private connections;
    private failedTargets;
    private retryInFlight;
    connect(name: string, sshCommand: string, root: string, password?: string, sudoPassword?: string): Promise<ConnectionInfo>;
    connectStartup(startup: StartupConnection): Promise<ConnectionInfo>;
    private connectLocal;
    private finishConnect;
    connectAll(startups: StartupConnection[]): Promise<ConnectAllResult>;
    /**
     * Attempt to reconnect an offline target if the cooldown has elapsed.
     * Returns the connection on success, null if still offline / throttled / unknown.
     */
    retryFailed(name: string): Promise<Connection | null>;
    private doRetryFailed;
    private recordFailure;
    get(target?: string): Connection | undefined;
    list(): ConnectionInfo[];
    targetNames(): string[];
    failedTargetNames(): string[];
    hasFailed(name: string): boolean;
    getFailedError(name: string): string | undefined;
    getFailedRetryAfterMs(name: string): number | undefined;
    listFailed(): FailedTarget[];
    /** Test-only: inject a prebuilt connection without SSH handshake. */
    setConnectionForTest(connection: Connection): void;
    /** Test-only: mark a target failed with a startup snapshot for retry tests. */
    setFailedForTest(startup: StartupConnection, error: string, lastAttempt?: number): void;
    close(): Promise<void>;
    private toInfo;
}
