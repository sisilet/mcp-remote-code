import type { RemoteConfig } from "./config.js";
export declare class PathMapper {
    readonly mirrorBase: string;
    readonly remoteRoot: string;
    constructor(config: RemoteConfig);
    private slugify;
    /** Convert a remote absolute path to a local mirror absolute path */
    toLocal(remotePath: string): string;
    /** Convert a local mirror absolute path back to a remote absolute path */
    toRemote(localPath: string): string;
    /** Check whether a remote path is within the configured remote workdir */
    isWithinWorkspace(remotePath: string): boolean;
    /** Get the manifest file path for this mirror */
    manifestPath(): string;
}
