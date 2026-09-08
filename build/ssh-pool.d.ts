import { type SFTPWrapper } from "ssh2";
export interface ExecOptions {
    cwd?: string;
    timeout?: number;
    /**
     * Re-run the command once if the connection drops mid-flight. Default
     * false: a command that partially executed before the drop would run
     * again, which is unsafe for anything non-idempotent (review F-3).
     * Internal idempotent probes (realpath, stat, uname) may opt in.
     */
    retry?: boolean;
    /** Cap on captured stdout+stderr bytes; output beyond this is dropped and marked. */
    maxOutputBytes?: number;
}
export interface SSHPool {
    exec(command: string, options?: ExecOptions): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T>;
    /**
     * Run a command and hand the caller its raw stdio streams. Needed for bulk
     * transfer, where piping a tar stream avoids one SFTP round trip per file
     * (review P-8). The caller must consume or destroy the streams.
     */
    execStream(command: string, options?: {
        timeout?: number;
    }): Promise<{
        stdout: NodeJS.ReadableStream;
        stdin: NodeJS.WritableStream;
        done: Promise<{
            exitCode: number;
            stderr: string;
        }>;
    }>;
    close(): Promise<void>;
}
/** 4 MB: comfortably above the MCP client's result limit, well below anything that hurts. */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/** Accumulates Buffer chunks up to a byte cap; decodes once, so UTF-8 is never split. */
export declare class BoundedBuffer {
    private readonly cap;
    private chunks;
    private bytes;
    private truncated;
    constructor(cap: number);
    push(chunk: Buffer): void;
    toString(): string;
}
export declare function intFromEnv(name: string, fallback: number, min: number, max: number): number;
export declare function isConnectionError(err: Error): boolean;
/**
 * Build ssh2 algorithms config from OpenSSH -o options.
 * CentOS 6 and other legacy systems need ssh-rsa (SHA-1) enabled.
 */
export declare function buildAlgorithms(extraOptions: string[]): any;
/** Read the algorithm name from an SSH public key blob: 4-byte length, then the name. */
export declare function detectKeyType(key: Buffer): string;
export declare function parseOpenSshOption(option: string): {
    key: string;
    value: string;
};
/**
 * ssh2 and child_process both report termination as (code, signal). A process
 * killed by a signal has no exit code, and `code ?? 0` turned that into a
 * reported success (review F-35), including for commands killed on timeout.
 */
export declare function exitCodeFrom(code: number | null | undefined, signal?: string | null): number;
export declare function appendSignal(stderr: string, signal?: string | null): string;
