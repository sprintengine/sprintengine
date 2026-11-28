import type { Workspace } from '../../../../../shared/workspace'
import { WINDOW_STUDIO_ROUTE } from '../../../studio/environmentStudio'
import { isEnvironmentRecord, type RemoteConversation } from '../remoteBand/remoteSessionsModel'

/**
 * This computer's chats as the sidebar draws them (design-environments PR 3):
 * the chats the window's own Studio lists (`environmentChats.ts`, the `local`
 * route), as any other machine's are, each wearing the changes asked of it and
 * not read back yet (`pendingChatChanges.ts`).
 *
 * The list says which chats have a row and what the row says of each: its
 * name, star and colour, its rest (settled, snoozed) and Auto-settle. The
 * window's record of the chat is what the row is drawn over: its panes and
 * arrangement, its terminals and their agents, its worktree and the clocks
 * this computer's terminal agents keep. A chat the list has and the window has
 * no record of yet (one just started elsewhere) is drawn once its record comes,
 * a moment later; a record the list does not name (a copy of another
 * machine's chat, a hidden kind) has no row here. The rows keep the window's
 * order of its records, which drag reorders.
 *
 * `rows` are the list's chats (any environment's; only this computer's are
 * read), and `settled` those it has settled, so that the chat in front keeps
 * its row until it is left (`isShelved`).
 */
export function localChatRows(
  records: readonly Workspace[],
  rows: readonly RemoteConversation[],
  settled: readonly RemoteConversation[],
): Workspace[] {
  const listed = new Map<string, RemoteConversation>()
  for (const row of settled) if (row.route === WINDOW_STUDIO_ROUTE) listed.set(row.workspaceId, row)
  // A chat both lists name (a list read between a Settle and the next) is drawn as its live row says.
  for (const row of rows) if (row.route === WINDOW_STUDIO_ROUTE) listed.set(row.workspaceId, row)
  const drawn: Workspace[] = []
  for (const record of records) {
    if (isEnvironmentRecord(record)) continue
    const row = listed.get(record.id)
    if (row) drawn.push(withRowFacts(record, row))
  }
  return drawn
}

/** The window's record of a chat, saying what its row says. */
function withRowFacts(record: Workspace, row: RemoteConversation): Workspace {
  const highlight = row.highlight ?? undefined
  const settledAt = typeof row.settledAt === 'number' ? row.settledAt : null
  const autoSettleEnabled = row.autoSettle ? true : null
  if (
    record.name === row.title &&
    record.highlight?.starred === highlight?.starred &&
    (record.highlight?.color ?? null) === (highlight?.color ?? null) &&
    (record.snoozedUntil ?? null) === row.snoozedUntil &&
    (record.settledAt ?? null) === settledAt &&
    (record.autoSettleEnabled === true ? true : null) === autoSettleEnabled
  )
    return record
  return { ...record, name: row.title, highlight, snoozedUntil: row.snoozedUntil, settledAt, autoSettleEnabled }
}
