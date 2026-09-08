import type { HostKeyPolicy } from "./known-hosts.js";
import type { ElicitationMode } from "./elicitation.js";
export interface RemoteConfig {
    sshCommand: string;
    host: string;
    user: string;
    port: number;
    identity?: string;
    extraOptions: string[];
    password?: string;
    /** Passphrase for an encrypted private key (review F-18). */
    passphrase?: string;
    sudoPassword?: string;
    remoteWorkdir: string;
    mirrorRoot: string;
    active: boolean;
    /** "verify" (default), "accept-new", or "insecure". See known-hosts.ts. */
    hostKeyPolicy?: HostKeyPolicy;
}
export interface StartupConnection {
    name: string;
    /** "ssh" (default) or "local" for a jailed local directory. */
    type?: "ssh" | "local";
    sshCommand: string;
    root: string;
    password?: string;
    sudoPassword?: string;
    /** If true, startup continues when this target cannot be reached. */
    optional?: boolean;
    /** Host key policy: "verify" (default), "accept-new", "insecure". */
    hostKeyPolicy?: HostKeyPolicy;
    /** "on" (default) prompts the user for outside-root commands; "off" disables. */
    elicitation?: ElicitationMode;
    /** Passphrase for an encrypted private key. */
    passphrase?: string;
    /**
     * Connection details taken straight from structured config, bypassing the
     * ssh-string round trip (review F-13). Building `ssh -i <path> user@host`
     * and re-parsing it loses any path containing a space: `-i "/a b/key.pem"`
     * parsed back as identity "/a" with the rest treated as the host. When
     * present these win over anything parsed from `sshCommand`.
     */
    connection?: {
        host: string;
        user: string;
        port?: number;
        identity?: string;
    };
}
export interface TargetsConfigFile {
    targets: Array<Record<string, unknown>>;
}
export declare const DEFAULT_CONFIG_PATH: string;
/** Previous default; still checked as a fallback when the new path is missing. */
export declare const LEGACY_CONFIG_PATH: string;
interface ParsedArgv {
    connections: StartupConnection[];
    configPaths: string[];
}
export declare function parseSshCommand(cmd: string): {
    host: string;
    user: string;
    port: number;
    identity?: string;
    extraOptions: string[];
};
export declare function buildRemoteConfig(sshCommand: string, remoteWorkdir: string, options?: {
    password?: string;
    passphrase?: string;
    sudoPassword?: string;
    mirrorRoot?: string;
    hostKeyPolicy?: HostKeyPolicy;
    connection?: {
        host: string;
        user: string;
        port?: number;
        identity?: string;
    };
}): RemoteConfig;
export declare function buildLocalConfig(root: string, options?: {
    mirrorRoot?: string;
}): RemoteConfig;
export declare function buildSshCommand(host: string, options?: {
    identity?: string;
    port?: number;
}): string;
export declare function parseRemoteSpec(value: string): {
    sshCommand: string;
    root: string;
};
export declare function loadTargetsConfigFile(configPath: string): Promise<StartupConnection[]>;
export declare function parseTargetsJson(parsed: unknown, label?: string): StartupConnection[];
export declare function loadTargetsFromEnv(): StartupConnection[] | null;
export declare function parseStartupConnections(argv?: string[]): ParsedArgv;
export declare function resolveStartupConnections(argv?: string[]): Promise<StartupConnection[]>;
export declare function validateStartupConnections(connections: StartupConnection[]): StartupConnection[];
export declare function parseStartupConnection(argv?: string[]): StartupConnection | null;
export declare function validateStartupConnection(connection: StartupConnection | null): StartupConnection;
export {};
