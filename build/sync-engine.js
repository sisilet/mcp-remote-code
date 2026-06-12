import fs from "fs/promises";
import path from "path";
export class SyncEngine {
    pathMapper;
    manifest;
    sshPool;
    mutex = Promise.resolve();
    constructor(_config, pathMapper, manifest, sshPool) {
        this.pathMapper = pathMapper;
        this.manifest = manifest;
        this.sshPool = sshPool;
    }
    async withLock(fn) {
        const release = this.mutex;
        let resolveRelease;
        this.mutex = new Promise((resolve) => {
            resolveRelease = resolve;
        });
        await release;
        try {
            return await fn();
        }
        finally {
            resolveRelease();
        }
    }
    /** Pull all tracked files from remote to local mirror */
    async pullAll() {
        await this.withLock(async () => {
            const files = this.manifest.remotePaths();
            if (files.length === 0)
                return;
            await this.runSftp("pull", files);
        });
    }
    /** Push all tracked files from local mirror to remote */
    async pushAll() {
        await this.withLock(async () => {
            const files = this.manifest.remotePaths();
            if (files.length === 0)
                return;
            await this.runSftp("push", files);
        });
    }
    /** Register a new remote file and ensure its parent directory exists locally */
    async register(remotePath) {
        const rel = this.manifest.register(remotePath);
        const localPath = this.pathMapper.toLocal(remotePath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await this.manifest.save();
        return rel;
    }
    async runSftp(direction, remotePaths) {
        await this.sshPool.withSftp(async (sftp) => {
            for (const rp of remotePaths) {
                const localPath = this.pathMapper.toLocal(rp);
                if (direction === "pull") {
                    // Ensure local parent dir exists
                    await fs.mkdir(path.dirname(localPath), { recursive: true }).catch(() => { });
                    try {
                        await sftpFastGet(sftp, rp, localPath);
                    }
                    catch (err) {
                        // If remote file does not exist, create an empty local file
                        // (handles "add file" patches where the file is new)
                        const msg = err.message.toLowerCase();
                        if (msg.includes("no such file") || msg.includes("not found")) {
                            await fs.writeFile(localPath, "", "utf-8");
                        }
                        else {
                            throw err;
                        }
                    }
                }
                else {
                    // Ensure remote parent dir exists
                    const remoteDir = path.posix.dirname(rp);
                    await this.sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { timeout: 10_000 }).catch(() => { });
                    await sftpFastPut(sftp, localPath, rp);
                }
            }
        });
    }
}
function sftpFastGet(sftp, remotePath, localPath) {
    return new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
}
function sftpFastPut(sftp, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
}
import { quoteShell } from "./shell-quote.js";
//# sourceMappingURL=sync-engine.js.map