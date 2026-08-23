import type { RemoteConfig } from "./config.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { type SSHPool } from "./ssh-pool.js";
import { SyncEngine } from "./sync-engine.js";
export interface Connection {
    name: string;
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
    host: string;
    user: string;
    port: number;
    workdir: string;
    platform: string;
    isGitRepo: boolean;
    connected: boolean;
}
export declare class ConnectionManager {
    private connections;
    connect(name: string, sshCommand: string, root: string, password?: string, sudoPassword?: string): Promise<ConnectionInfo>;
    connectAll(startups: Array<{
        name: string;
        sshCommand: string;
        root: string;
        password?: string;
        sudoPassword?: string;
    }>): Promise<ConnectionInfo[]>;
    get(target?: string): Connection | undefined;
    list(): ConnectionInfo[];
    targetNames(): string[];
    /** Test-only: inject a prebuilt connection without SSH handshake. */
    setConnectionForTest(connection: Connection): void;
    close(): Promise<void>;
    private toInfo;
}
