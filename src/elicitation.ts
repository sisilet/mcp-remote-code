import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

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

export type ElicitationMode = "on" | "off"

export interface ElicitationOutcome {
  /** True when the operation may proceed. */
  approved: boolean
  /** How the decision was reached, for the caller to report honestly. */
  via: "user-accepted" | "user-declined" | "unsupported" | "disabled" | "error"
  detail?: string
}

let serverRef: McpServer | undefined
let globalMode: ElicitationMode = "on"

export function initElicitation(server: McpServer, mode: ElicitationMode): void {
  serverRef = server
  globalMode = mode
}

/** Per-target setting overrides the global one when present. */
export function resolveMode(targetMode?: ElicitationMode): ElicitationMode {
  return targetMode ?? globalMode
}

export function clientSupportsElicitation(): boolean {
  try {
    const caps = (serverRef as any)?.server?.getClientCapabilities?.()
    return Boolean(caps && "elicitation" in caps)
  } catch {
    return false
  }
}

/**
 * Ask the user to approve a potentially dangerous operation.
 * `summary` should state plainly what will happen, on which target.
 */
export async function confirmWithUser(
  summary: string,
  targetMode?: ElicitationMode
): Promise<ElicitationOutcome> {
  if (resolveMode(targetMode) === "off") {
    return { approved: false, via: "disabled" }
  }
  if (!serverRef || !clientSupportsElicitation()) {
    return { approved: false, via: "unsupported" }
  }

  try {
    const result: any = await (serverRef as any).server.elicitInput({
      message: summary,
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            title: "Proceed?",
            description: "Allow this operation to run on the remote machine.",
          },
        },
        required: ["approve"],
      },
    })

    if (result?.action !== "accept") {
      return { approved: false, via: "user-declined", detail: result?.action }
    }
    const approve = result?.content?.approve
    return approve === true
      ? { approved: true, via: "user-accepted" }
      : { approved: false, via: "user-declined", detail: "answered no" }
  } catch (err) {
    // Never fail open: an elicitation error means no approval was obtained.
    return { approved: false, via: "error", detail: (err as Error).message }
  }
}
