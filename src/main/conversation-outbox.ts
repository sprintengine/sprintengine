import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from './config-file-write'
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
 * It is written ahead: a chat goes in before its turn's message is
 * committed, and comes out once the chat is at rest again. A chat listed
 * whose log has no open turn costs a look at the end of its log; nothing is
 * decided here, the log is what says whether a turn is open. It is an aid,
 * not a dependency: a list that cannot be read or written leaves a turn to
 * be closed when its chat is next opened, as it was before there was one.
 */

export const CONVERSATION_OUTBOX_FILE = 'conversation-outbox.json'

type Stored = { version: 1; chats: ConversationKey[] }

const chatId = (chat: ConversationKey) => JSON.stringify([chat.workspaceRoot, chat.workspaceId, chat.agentId])

export class ConversationOutbox {
  private readonly chats = new Map<string, ConversationKey>()
  private loaded: Promise<void> | null = null
  // Every change counts up; a write carries the count it was taken at, and
  // `written` is the newest count on disk.
  private changes = 0
  private written = 0
  private writing: Promise<void> | null = null

  /** Without a directory nothing is kept, and a start recovers nothing: what tests that need no recovery construct. */
  constructor(private readonly userDataDir?: string) {}

  private get file(): string | null {
    return this.userDataDir ? join(this.userDataDir, CONVERSATION_OUTBOX_FILE) : null
  }

  /** The chats the last run left listed. */
  async pending(): Promise<ConversationKey[]> {
    await this.load()
    return [...this.chats.values()]
  }

  /**
   * List a chat before its turn's message is committed; settles once that is
   * on disk, and fails when it could not be written.
   */
  async open(chat: ConversationKey): Promise<void> {
    await this.load()
    const id = chatId(chat)
    if (this.chats.has(id) && this.written === this.changes) return
    this.chats.set(id, { workspaceRoot: chat.workspaceRoot, workspaceId: chat.workspaceId, agentId: chat.agentId })
    this.changes += 1
    await this.save(this.changes)
  }

  /** The chat is at rest. A chat listed too long only costs a look at a start, so a failed write is let go. */
  settle(chat: ConversationKey): Promise<void> {
    if (!this.chats.delete(chatId(chat))) return Promise.resolve()
    this.changes += 1
    return this.save(this.changes).catch(() => undefined)
  }

  /**
   * Read once. A file that does not read is not remembered as read: the next
   * call tries again, and meanwhile nothing is listed from it.
   */
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
    const file = this.file
    if (!file) return
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    // A file that does not parse lists nothing: the turns it named are closed
    // when their chats are next opened.
    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch {
      return
    }
    const chats = (stored as Partial<Stored> | null)?.chats
    if (!Array.isArray(chats)) return
    for (const chat of chats) if (isKey(chat) && !this.chats.has(chatId(chat))) this.chats.set(chatId(chat), chat)
  }

  /** Write until the file holds change `change` or later; fails when the write that should have carried it did not land. */
  private async save(change: number): Promise<void> {
    const file = this.file
    if (!file) {
      this.written = Math.max(this.written, change)
      return
    }
    while (this.written < change) {
      if (this.writing) {
        await this.writing.catch(() => undefined)
        continue
      }
      const taken = this.changes
      const body: Stored = { version: 1, chats: [...this.chats.values()] }
      this.writing = (async () => {
        await mkdir(dirname(file), { recursive: true })
        await writeFileAtomically(file, `${JSON.stringify(body)}\n`)
        this.written = Math.max(this.written, taken)
      })()
      try {
        await this.writing
      } finally {
        this.writing = null
      }
    }
  }
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
