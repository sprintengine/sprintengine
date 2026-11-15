// Which turn failures this window has told the Notifications panel of: a
// failure is told once, however often its chat's events are read again (a
// reconnect re-reads them whole; a server restarted under the chat serves the
// same log; a chat view mounts again when its pane does). The first time this
// window sees a chat's history, a failure already in it is not told: it
// happened before this window was watching, and the chat shows it. Kept for
// the window's life, and only the latest few hundred.

const TOLD_LIMIT = 500
const told = new Set<string>()
const sighted = new Set<string>()

function remember(set: Set<string>, key: string): void {
  set.add(key)
  if (set.size > TOLD_LIMIT) set.delete(set.values().next().value as string)
}

/**
 * Whether to tell of a chat's latest failure now, which `failure` names (its
 * event's id; null when the chat has none). Asked each time the chat's
 * history, read whole, says what its latest failure is. The first time
 * this window asks of a chat, what is there already is marked told and not
 * told. After that, each failure is told once.
 */
export function tellOfTurnFailure(workspaceId: string, agentId: string, failure: string | null): boolean {
  const chat = JSON.stringify([workspaceId, agentId])
  const key = failure === null ? null : JSON.stringify([workspaceId, agentId, failure])
  if (!sighted.has(chat)) {
    remember(sighted, chat)
    if (key) remember(told, key)
    return false
  }
  if (!key || told.has(key)) return false
  remember(told, key)
  return true
}

/** Test seam: forget every chat seen and failure told. */
export function resetTurnFailureNoticesForTests(): void {
  told.clear()
  sighted.clear()
}
