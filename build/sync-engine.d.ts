import type { RemoteConfig } from "./config.js";
import type { ManifestManager } from "./manifest.js";
import type { PathMapper } from "./path-mapper.js";
import type { SSHPool } from "./ssh-pool.js";
export declare class SyncEngine {
    private pathMapper;
    private manifest;
    private sshPool;
    private mutex;
    constructor(_config: RemoteConfig, pathMapper: PathMapper, manifest: ManifestManager, sshPool: SSHPool);
    private withLock;
    /** Pull all tracked files from remote to local mirror */
    pullAll(): Promise<void>;
    /** Push all tracked files from local mirror to remote */
    pushAll(): Promise<void>;
    /** Register a new remote file and ensure its parent directory exists locally */
    register(remotePath: string): Promise<string>;
    private runSftp;
}
