export const CONFIRMATION_TTL_MS = 10 * 60 * 1000

const pendingConfirmations = new Map<string, number>()

export function requestConfirmation(key: string): void {
  pendingConfirmations.set(key, Date.now() + CONFIRMATION_TTL_MS)
}

export function hasFreshConfirmation(key: string): boolean {
  const expiresAt = pendingConfirmations.get(key)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    pendingConfirmations.delete(key)
    return false
  }
  return true
}

export function consumeConfirmation(key: string): void {
  pendingConfirmations.delete(key)
}

export function clearConfirmations(): void {
  pendingConfirmations.clear()
}

export type ConfirmationOutcome =
  | { status: "execute" }
  | { status: "pending"; message: string }
  | { status: "needs_force"; message: string }

export function checkConfirmation(
  key: string,
  needsConfirm: boolean,
  force: boolean | undefined,
  renderPendingMessage: () => string,
  renderNeedsForceMessage: () => string
): ConfirmationOutcome {
  if (!needsConfirm) {
    return { status: "execute" }
  }
  if (!hasFreshConfirmation(key)) {
    requestConfirmation(key)
    return { status: "pending", message: renderPendingMessage() }
  }
  if (!force) {
    return { status: "needs_force", message: renderNeedsForceMessage() }
  }
  consumeConfirmation(key)
  return { status: "execute" }
}
