import path from "path";
import { isUnderRoot } from "./root-jail.js";
export class PathMapper {
    mirrorBase;
    remoteRoot;
    constructor(config) {
        const hostSlug = this.slugify(`${config.user}_${config.host}`);
        const rootSlug = this.slugify(config.remoteWorkdir);
        this.mirrorBase = path.join(config.mirrorRoot, hostSlug, rootSlug);
        this.remoteRoot = config.remoteWorkdir;
    }
    slugify(input) {
        return input
            .replace(/^\//, "")
            .replace(/\/+$/, "")
            .replace(/\//g, "_")
            .replace(/[^a-zA-Z0-9_.@-]/g, "-");
    }
    /** Convert a remote absolute path to a local mirror absolute path */
    toLocal(remotePath) {
        const normalized = path.posix.normalize(remotePath);
        if (!path.posix.isAbsolute(normalized)) {
            throw new Error(`Remote Code: path "${remotePath}" must be absolute`);
        }
        let relative;
        if (this.isWithinWorkspace(normalized)) {
            relative = path.posix.relative(this.remoteRoot, normalized);
        }
        else {
            // Path outside remoteRoot: use full absolute path (strip leading /)
            relative = normalized.replace(/^\//, "");
        }
        const local = relative === "" ? this.mirrorBase : path.join(this.mirrorBase, ...relative.split("/"));
        // Security: ensure resolved path stays within mirrorBase
        const resolved = path.resolve(local);
        const baseResolved = path.resolve(this.mirrorBase);
        if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
            throw new Error(`Remote Code: resolved local path "${resolved}" escapes mirror base "${baseResolved}"`);
        }
        return resolved;
    }
    /** Convert a local mirror absolute path back to a remote absolute path */
    toRemote(localPath) {
        const resolved = path.resolve(localPath);
        const baseResolved = path.resolve(this.mirrorBase);
        if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
            throw new Error(`Remote Code: local path "${localPath}" is outside mirror base "${baseResolved}"`);
        }
        const relative = path.relative(baseResolved, resolved);
        const posixRel = relative.split(path.sep).join("/");
        if (posixRel === "" || posixRel === ".") {
            return this.remoteRoot;
        }
        // Determine whether this local path originated from inside remoteRoot.
        // For paths inside remoteRoot, the stored relative path is simply the
        // path relative to remoteRoot (e.g. "foo.txt" or "src/main.ts").
        // For external paths, the stored relative path is the full absolute
        // path without the leading slash (e.g. "boot/grub.conf").
        const candidateInside = path.posix.join(this.remoteRoot, posixRel);
        const localInside = candidateInside === this.remoteRoot
            ? this.mirrorBase
            : path.join(this.mirrorBase, ...path.posix.relative(this.remoteRoot, candidateInside).split("/"));
        if (path.resolve(localInside) === resolved) {
            return candidateInside;
        }
        // Otherwise it was mapped from an external absolute path
        return "/" + posixRel;
    }
    /**
     * Is a remote path within the configured remote workdir?
     *
     * Shares the root-jail prefix rule, including its handling of a root of
     * "/" (review F-2, missed here: review F-45). Building `remoteRoot + "/"`
     * yields "//" for that root, so every path looked external and every file
     * was mirrored under its full absolute path.
     */
    isWithinWorkspace(remotePath) {
        return isUnderRoot(this.remoteRoot, path.posix.normalize(remotePath));
    }
    /** Get the manifest file path for this mirror */
    manifestPath() {
        return path.join(this.mirrorBase, "manifest.json");
    }
}
//# sourceMappingURL=path-mapper.js.map