import fs from "fs/promises";
import path from "path";
export class ManifestManager {
    manifest;
    path;
    dirty = false;
    constructor(pathMapper) {
        this.path = pathMapper.manifestPath();
        this.manifest = {
            remote_root: pathMapper.remoteRoot,
            files: {},
        };
    }
    /** Start from an empty manifest for a fresh connection (review F-21). */
    reset(remoteRoot) {
        ;
        this.manifest = { remote_root: remoteRoot, files: {} };
    }
    async load() {
        try {
            const data = await fs.readFile(this.path, "utf-8");
            const parsed = JSON.parse(data);
            if (parsed.remote_root && typeof parsed.files === "object") {
                this.manifest = parsed;
            }
        }
        catch {
            // Manifest doesn't exist yet; start empty
        }
    }
    async save() {
        if (!this.dirty)
            return;
        await fs.mkdir(path.dirname(this.path), { recursive: true });
        await fs.writeFile(this.path, JSON.stringify(this.manifest, null, 2), "utf-8");
        this.dirty = false;
    }
    /** Register a remote file path. Returns its local relative path. */
    register(remotePath) {
        if (this.manifest.files[remotePath]) {
            return this.manifest.files[remotePath];
        }
        const normalized = path.posix.normalize(remotePath);
        let rel;
        if (normalized === this.manifest.remote_root ||
            normalized.startsWith(this.manifest.remote_root + "/")) {
            rel = path.posix.relative(this.manifest.remote_root, normalized);
        }
        else {
            // Path outside remote_root: use full absolute path (strip leading /)
            rel = normalized.replace(/^\//, "");
        }
        this.manifest.files[remotePath] = rel;
        this.dirty = true;
        return rel;
    }
    /** Check if a remote path is already tracked. */
    has(remotePath) {
        return remotePath in this.manifest.files;
    }
    /** Get all tracked remote paths. */
    remotePaths() {
        return Object.keys(this.manifest.files);
    }
    /** Get the relative local path for a tracked remote path. */
    getRel(remotePath) {
        return this.manifest.files[remotePath];
    }
    /** Remove a tracked path. */
    remove(remotePath) {
        if (remotePath in this.manifest.files) {
            delete this.manifest.files[remotePath];
            this.dirty = true;
        }
    }
}
//# sourceMappingURL=manifest.js.map