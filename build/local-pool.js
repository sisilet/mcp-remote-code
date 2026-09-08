import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { BoundedBuffer, DEFAULT_MAX_OUTPUT_BYTES, appendSignal, exitCodeFrom, } from "./ssh-pool.js";
/**
 * Local filesystem/exec backend that matches the SSHPool surface so tools
 * can treat local targets the same as remote ones.
 */
export function createLocalPool() {
    return {
        async exec(command, options = {}) {
            return execLocal(command, options.cwd, options.timeout, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
        },
        async execStream(command, options = {}) {
            const child = spawn(command, { shell: true, env: process.env });
            // Was an unbounded string concat with the timeout option accepted and
            // then ignored (review F-36), so a local target could hang forever or
            // grow without limit — the two problems the SSH path already solved.
            const errBuf = new BoundedBuffer(64 * 1024);
            child.stderr.on("data", (d) => errBuf.push(d));
            const done = new Promise((resolve) => {
                let settled = false;
                const finish = (exitCode, stderr) => {
                    if (settled)
                        return;
                    settled = true;
                    if (timer)
                        clearTimeout(timer);
                    resolve({ exitCode, stderr });
                };
                const timer = options.timeout
                    ? setTimeout(() => {
                        child.kill("SIGKILL");
                        finish(-1, `timeout after ${options.timeout}ms`);
                    }, options.timeout)
                    : undefined;
                child.on("close", (code, signal) => finish(exitCodeFrom(code, signal), appendSignal(errBuf.toString(), signal)));
                child.on("error", (err) => finish(-1, err.message));
            });
            return { stdout: child.stdout, stdin: child.stdin, done };
        },
        async withSftp(fn) {
            const sftp = createLocalSftpShim();
            try {
                return await fn(sftp);
            }
            finally {
                sftp.end();
            }
        },
        async close() { },
    };
}
function execLocal(command, cwd, timeoutMs = 60_000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            shell: true,
            cwd,
            env: process.env,
        });
        const outBuf = new BoundedBuffer(maxOutputBytes);
        const errBuf = new BoundedBuffer(maxOutputBytes);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGKILL");
            reject(new Error(`Local command timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            outBuf.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            errBuf.push(chunk);
        });
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                stdout: outBuf.toString(),
                stderr: appendSignal(errBuf.toString(), signal),
                exitCode: exitCodeFrom(code, signal),
            });
        });
    });
}
function createLocalSftpShim() {
    const shim = {
        fastGet(remotePath, localPath, cb) {
            copyFile(remotePath, localPath).then(() => cb(null), (err) => cb(err));
        },
        fastPut(localPath, remotePath, cb) {
            copyFile(localPath, remotePath).then(() => cb(null), (err) => cb(err));
        },
        end() { },
    };
    return shim;
}
async function copyFile(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
}
//# sourceMappingURL=local-pool.js.map