import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/**
 * Real user confirmation via MCP elicitation (review F-5, decision D-B).
 *
 * The pre-existing `confirmation.ts` mechanism asks the *model* to repeat a
 * call with force=true. That constrains a careless model, not a determined
 * one, and no human ever sees a prompt. This asks the client to put the
 * question to the user.
 *
 * Degrades safely and explicitly:
 *  - client does not advertise elicitation  -> fall back to the model-side
 *    acknowledgement, and say so in the returned text
 *  - user declines or cancels               -> refuse the operation
 *  - disabled in config                     -> fall back, no prompt
 */
export type ElicitationMode = "on" | "off";
export interface ElicitationOutcome {
    /** True when the operation may proceed. */
    approved: boolean;
    /** How the decision was reached, for the caller to report honestly. */
    via: "user-accepted" | "user-declined" | "unsupported" | "disabled" | "error";
    detail?: string;
}
export declare function initElicitation(server: McpServer, mode: ElicitationMode): void;
/** Per-target setting overrides the global one when present. */
export declare function resolveMode(targetMode?: ElicitationMode): ElicitationMode;
export declare function clientSupportsElicitation(): boolean;
/**
 * Ask the user to approve a potentially dangerous operation.
 * `summary` should state plainly what will happen, on which target.
 */
export declare function confirmWithUser(summary: string, targetMode?: ElicitationMode): Promise<ElicitationOutcome>;
