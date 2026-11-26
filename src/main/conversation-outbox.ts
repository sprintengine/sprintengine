import type { StudioDatabase } from '../server/db/database'
import type { ConversationKey } from '../shared/conversation-runtime'

/**
 * The chats whose provider turn may still be open: the outbox of the turns
 * this machine's runtime runs.
 *
 * A turn is a send's effect. Its message is committed to the chat's log, and
 * the agent works after that; if Studio stops while it does, the log ends on
 * a turn nothing will end. This file says which chats that can be, so a start
 * finds and closes each one at once rather than when someone opens the chat:
 * an answer a client is waiting on, a schedule's run and the chat list all
 * see the turn end.
 *
 * It is written ahead: a chat goes in (`turn_outbox`, in the data folder's
 * database) before its turn's message is committed, and comes out once the
 * chat is at rest again. A chat listed
 * whose log has no open turn costs a look at the end of its log; nothing is
 * decided here, the log is what says whether a turn is open. It is an aid,
 * not a dependency: a list that cannot be read or written leaves a turn to
 * be closed when its chat is next opened, as it was before there was one.
 */

/** The file builds before the database kept the list in, under the data folder; read once, by the import. */
export const CONVERSATION_OUTBOX_FILENAME_FOR_IMPORT = 'conversation-outbox.json'

const chatId = (chat: ConversationKey) => JSON.stringify([chat.workspaceRoot, chat.workspaceId, chat.agentId])

export class ConversationOutbox {
  private readonly chats = new Map<string, ConversationKey>()
  private loaded: Promise<void> | null = null

  /** Without a database nothing is kept, and a start recovers nothing: what tests that need no recovery construct. */
  constructor(private readonly database?: StudioDatabase) {}

  /** The chats the last run left listed. */
  async pending(): Promise<ConversationKey[]> {
    await this.load()
    return [...this.chats.values()]
  }

  /** List a chat before its turn's message is committed; settles once that is committed, and fails when it could not be. */
  async open(chat: ConversationKey): Promise<void> {
    await this.load()
    const id = chatId(chat)
    const key = { workspaceRoot: chat.workspaceRoot, workspaceId: chat.workspaceId, agentId: chat.agentId }
    await this.database?.run(
      'INSERT OR IGNORE INTO turn_outbox (workspace_root, workspace_id, agent_id) VALUES (?, ?, ?)',
      [key.workspaceRoot, key.workspaceId, key.agentId],
    )
    this.chats.set(id, key)
  }

  /** The chat is at rest. A chat listed too long only costs a look at a start, so a failed write is let go. */
  settle(chat: ConversationKey): Promise<void> {
    if (!this.chats.delete(chatId(chat))) return Promise.resolve()
    return (
      this.database
        ?.run('DELETE FROM turn_outbox WHERE workspace_root = ? AND workspace_id = ? AND agent_id = ?', [
          chat.workspaceRoot,
          chat.workspaceId,
          chat.agentId,
        ])
        .then(() => undefined)
        .catch(() => undefined) ?? Promise.resolve()
    )
  }

  /** Read once. A list that does not read is not remembered as read: the next call tries again. */
  private load(): Promise<void> {
    this.loaded ??= this.read().catch((error: unknown) => {
      this.loaded = null
      console.warn(
        '[conversation-outbox] the list of open turns could not be read:',
        error instanceof Error ? error.message : error,
      )
    })
    return this.loaded
  }

  private async read(): Promise<void> {
    if (!this.database) return
    const rows = await this.database.all<{ workspace_root: string; workspace_id: string; agent_id: string }>(
      'SELECT workspace_root, workspace_id, agent_id FROM turn_outbox',
    )
    for (const row of rows) {
      const chat = { workspaceRoot: row.workspace_root, workspaceId: row.workspace_id, agentId: row.agent_id }
      if (!this.chats.has(chatId(chat))) this.chats.set(chatId(chat), chat)
    }
  }
}

/** The chats the file builds before the database wrote lists (the import); null for one that is not that. */
export function readConversationOutboxFile(raw: string): ConversationKey[] | null {
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }
  const chats = (stored as { chats?: unknown } | null)?.chats
  if (!Array.isArray(chats)) return null
  return chats.filter(isKey)
}

function isKey(value: unknown): value is ConversationKey {
  if (!value || typeof value !== 'object') return false
  const { workspaceRoot, workspaceId, agentId } = value as Record<string, unknown>
  return (
    typeof workspaceRoot === 'string' &&
    !!workspaceRoot &&
    typeof workspaceId === 'string' &&
    !!workspaceId &&
    typeof agentId === 'string' &&
    !!agentId
  )
}
