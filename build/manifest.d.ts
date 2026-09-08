import type { PathMapper } from "./path-mapper.js";
export interface Manifest {
    remote_root: string;
    files: Record<string, string>;
    /**
     * Remote stamp (mtime:size) of each tracked file as observed at its last
     * pull. Consulted before a push: if the remote no longer matches, someone
     * changed it outside this tool and a push would destroy their work.
     * Optional so manifests written before this field existed still load.
     */
    pulled?: Record<string, string>;
}
export declare class ManifestManager {
    private manifest;
    private path;
    private dirty;
    constructor(pathMapper: PathMapper);
    /** Start from an empty manifest for a fresh connection (review F-21). */
    reset(remoteRoot: string): void;
    load(): Promise<void>;
    save(): Promise<void>;
    /** Register a remote file path. Returns its local relative path. */
    register(remotePath: string): string;
    /** Check if a remote path is already tracked. */
    has(remotePath: string): boolean;
    /** Get all tracked remote paths. */
    remotePaths(): string[];
    /** Get the relative local path for a tracked remote path. */
    getRel(remotePath: string): string | undefined;
    /** Remove a tracked path. */
    remove(remotePath: string): void;
    /** Record the remote stamp observed when this file was last pulled or pushed. */
    setPulled(remotePath: string, stamp: string): void;
    /** The remote stamp seen at last pull/push, or undefined if never observed. */
    getPulled(remotePath: string): string | undefined;
}
