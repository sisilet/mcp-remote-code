export interface RemoteConfig {
    sshCommand: string;
    host: string;
    user: string;
    port: number;
    identity?: string;
    extraOptions: string[];
    password?: string;
    sudoPassword?: string;
    remoteWorkdir: string;
    mirrorRoot: string;
    active: boolean;
}
export interface StartupConnection {
    name: string;
    sshCommand: string;
    root: string;
    password?: string;
    sudoPassword?: string;
}
export interface TargetsConfigFile {
    targets: StartupConnection[];
}
export declare const DEFAULT_CONFIG_PATH: string;
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
    sudoPassword?: string;
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
