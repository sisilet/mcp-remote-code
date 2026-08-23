import { z } from "zod";
import type { Connection, ConnectionManager } from "./connection-manager.js";
export declare const targetSchema: z.ZodOptional<z.ZodString>;
export declare function requireConnection(connectionManager: ConnectionManager, target?: string): Connection | {
    errorText: string;
};
export declare function textResult(text: string): {
    content: {
        type: "text";
        text: string;
    }[];
};
export declare function jailRemotePath(conn: Connection, input: string, options?: {
    forNewFile?: boolean;
    allowMissing?: boolean;
}): Promise<{
    path: string;
} | {
    errorText: string;
}>;
export declare function jailRemoteDir(conn: Connection, input?: string): {
    path: string;
} | {
    errorText: string;
};
