let serverRef;
let globalMode = "on";
export function initElicitation(server, mode) {
    serverRef = server;
    globalMode = mode;
}
/** Per-target setting overrides the global one when present. */
export function resolveMode(targetMode) {
    return targetMode ?? globalMode;
}
export function clientSupportsElicitation() {
    try {
        const caps = serverRef?.server?.getClientCapabilities?.();
        return Boolean(caps && "elicitation" in caps);
    }
    catch {
        return false;
    }
}
/**
 * Ask the user to approve a potentially dangerous operation.
 * `summary` should state plainly what will happen, on which target.
 */
export async function confirmWithUser(summary, targetMode) {
    if (resolveMode(targetMode) === "off") {
        return { approved: false, via: "disabled" };
    }
    if (!serverRef || !clientSupportsElicitation()) {
        return { approved: false, via: "unsupported" };
    }
    try {
        const result = await serverRef.server.elicitInput({
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
        });
        if (result?.action !== "accept") {
            return { approved: false, via: "user-declined", detail: result?.action };
        }
        const approve = result?.content?.approve;
        return approve === true
            ? { approved: true, via: "user-accepted" }
            : { approved: false, via: "user-declined", detail: "answered no" };
    }
    catch (err) {
        // Never fail open: an elicitation error means no approval was obtained.
        return { approved: false, via: "error", detail: err.message };
    }
}
//# sourceMappingURL=elicitation.js.map