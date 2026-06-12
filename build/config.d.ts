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
export interface StartupConnection {
    name: string;
    sshCommand: string;
    workdir: string;
    password?: string;
    sudoPassword?: string;
}
export declare function parseStartupConnections(): StartupConnection[];
