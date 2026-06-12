import type { PathMapper } from "./path-mapper.js";
export interface Manifest {
    remote_root: string;
    files: Record<string, string>;
}
export declare class ManifestManager {
    private manifest;
    private path;
    private dirty;
    constructor(pathMapper: PathMapper);
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
}
