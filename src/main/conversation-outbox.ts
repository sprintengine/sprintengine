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
 * decided here, the log is what says whether a turn is open.
 */

export const CONVERSATION_OUTBOX_FILE = 'conversation-outbox.json'

type Stored = { version: 1; chats: ConversationKey[] }

const chatId = (chat: ConversationKey) => JSON.stringify([chat.workspaceRoot, chat.workspaceId, chat.agentId])

export class ConversationOutbox {
  private readonly chats = new Map<string, ConversationKey>()
  private loaded: Promise<void> | null = null
  // One write at a time; a change made while one runs is written after it.
  private writing: Promise<void> | null = null
  private dirty = false

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

  /** List a chat before its turn's message is committed; settles once that is on disk. */
  async open(chat: ConversationKey): Promise<void> {
    await this.load()
    const id = chatId(chat)
    if (this.chats.has(id)) return
    this.chats.set(id, { workspaceRoot: chat.workspaceRoot, workspaceId: chat.workspaceId, agentId: chat.agentId })
    await this.save()
  }

  /** The chat is at rest. Written in the background: a chat listed too long only costs a look at a start. */
  settle(chat: ConversationKey): Promise<void> {
    if (!this.chats.delete(chatId(chat))) return Promise.resolve()
    return this.save().catch(() => undefined)
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.file
      if (!file) return
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      // A file that does not read lists nothing: the turns it named are closed
      // when their chats are next opened, as before there was this file.
      let stored: unknown
      try {
        stored = JSON.parse(raw)
      } catch {
        return
      }
      const chats = (stored as Partial<Stored> | null)?.chats
      if (!Array.isArray(chats)) return
      for (const chat of chats) {
        if (!isKey(chat)) continue
        this.chats.set(chatId(chat), chat)
      }
    })()
    return this.loaded
  }

  private async save(): Promise<void> {
    const file = this.file
    if (!file) return
    this.dirty = true
    while (this.writing) await this.writing.catch(() => undefined)
    if (!this.dirty) return
    this.dirty = false
    const body: Stored = { version: 1, chats: [...this.chats.values()] }
    this.writing = (async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomically(file, `${JSON.stringify(body)}\n`)
    })()
    try {
      await this.writing
    } finally {
      this.writing = null
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
