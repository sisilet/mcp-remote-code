import type { RemoteConfig } from "./config.js";
import { ManifestManager } from "./manifest.js";
import { PathMapper } from "./path-mapper.js";
import { type SSHPool } from "./ssh-pool.js";
import { SyncEngine } from "./sync-engine.js";
export interface MachineConfig {
    name: string;
    sshCommand: string;
    workdir: string;
    password?: string;
    sudoPassword?: string;
    description?: string;
}
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
    private configs;
    private configFilePath;
    private readyPromise;
    constructor();
    private loadConfigs;
    ready(): Promise<void>;
    private saveConfigs;
    addConfig(config: MachineConfig): Promise<void>;
    removeConfig(name: string): Promise<void>;
    getConfig(name: string): MachineConfig | undefined;
    listConfigs(): Array<MachineConfig & {
        connected: boolean;
    }>;
    connectFromConfig(name: string): Promise<ConnectionInfo>;
    connectWithParams(name: string, sshCommand: string, workdir: string, password?: string, sudoPassword?: string): Promise<ConnectionInfo>;
    disconnect(name: string): Promise<void>;
    get(name?: string): Connection | undefined;
    list(): ConnectionInfo[];
    closeAll(): Promise<void>;
}
