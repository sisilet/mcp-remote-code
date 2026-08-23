import type { SSHPool } from "./ssh-pool.js";
export interface RootJailResult {
    path?: string;
    error?: string;
}
export declare function isUnderRoot(root: string, candidate: string): boolean;
export declare function resolveUnderRootSync(root: string, input: string): RootJailResult;
export declare function resolveUnderRoot(root: string, input: string, sshPool: SSHPool, options?: {
    forNewFile?: boolean;
    allowMissing?: boolean;
}): Promise<RootJailResult>;
export declare function remoteRealpath(sshPool: SSHPool, remotePath: string): Promise<string | null>;
