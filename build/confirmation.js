export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const pendingConfirmations = new Map();
export function requestConfirmation(key) {
    pendingConfirmations.set(key, Date.now() + CONFIRMATION_TTL_MS);
}
export function hasFreshConfirmation(key) {
    const expiresAt = pendingConfirmations.get(key);
    if (!expiresAt)
        return false;
    if (expiresAt <= Date.now()) {
        pendingConfirmations.delete(key);
        return false;
    }
    return true;
}
export function consumeConfirmation(key) {
    pendingConfirmations.delete(key);
}
export function clearConfirmations() {
    pendingConfirmations.clear();
}
export function checkConfirmation(key, needsConfirm, force, renderPendingMessage, renderNeedsForceMessage) {
    if (!needsConfirm) {
        return { status: "execute" };
    }
    if (!hasFreshConfirmation(key)) {
        requestConfirmation(key);
        return { status: "pending", message: renderPendingMessage() };
    }
    if (!force) {
        return { status: "needs_force", message: renderNeedsForceMessage() };
    }
    consumeConfirmation(key);
    return { status: "execute" };
}
//# sourceMappingURL=confirmation.js.map