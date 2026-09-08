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
    /**
     * Is a remote path within the configured remote workdir?
     *
     * Shares the root-jail prefix rule, including its handling of a root of
     * "/" (review F-2, missed here: review F-45). Building `remoteRoot + "/"`
     * yields "//" for that root, so every path looked external and every file
     * was mirrored under its full absolute path.
     */
    isWithinWorkspace(remotePath: string): boolean;
    /** Get the manifest file path for this mirror */
    manifestPath(): string;
}
