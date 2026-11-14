// Which turn failures this window has told the Notifications panel of: a
// failure is told once, however often its chat's events are read again (a
// reconnect re-reads them whole; a server restarted under the chat serves the
// same log; a chat view mounts again when its pane does). Kept for the
// window's life, and only the latest few hundred.

const TOLD_LIMIT = 500
const told = new Set<string>()

/**
 * Whether this is the first time this window tells of a chat's failure,
 * which `failure` names (its event's id); marks it told either way.
 */
export function firstTellingOfTurnFailure(workspaceId: string, agentId: string, failure: string): boolean {
  const key = JSON.stringify([workspaceId, agentId, failure])
  if (told.has(key)) return false
  told.add(key)
  if (told.size > TOLD_LIMIT) told.delete(told.values().next().value as string)
  return true
}

/** Test seam: forget every failure told. */
export function resetTurnFailureNoticesForTests(): void {
  told.clear()
}
