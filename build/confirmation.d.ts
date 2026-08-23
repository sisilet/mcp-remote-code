export declare const CONFIRMATION_TTL_MS: number;
export declare function requestConfirmation(key: string): void;
export declare function hasFreshConfirmation(key: string): boolean;
export declare function consumeConfirmation(key: string): void;
export declare function clearConfirmations(): void;
export type ConfirmationOutcome = {
    status: "execute";
} | {
    status: "pending";
    message: string;
} | {
    status: "needs_force";
    message: string;
};
export declare function checkConfirmation(key: string, needsConfirm: boolean, force: boolean | undefined, renderPendingMessage: () => string, renderNeedsForceMessage: () => string): ConfirmationOutcome;
