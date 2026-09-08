import { type SSHPool } from "./ssh-pool.js";
/**
 * Local filesystem/exec backend that matches the SSHPool surface so tools
 * can treat local targets the same as remote ones.
 */
export declare function createLocalPool(): SSHPool;
