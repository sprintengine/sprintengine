import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { ConversationImageAttachment, ConversationPromptHookAs } from '../shared/conversation-runtime'
import type { StudioDatabase } from '../server/db/database'
import { writeFileAtomic } from '../server/platform/atomic-file'

// The first messages of chats a launch made, kept in the data folder's
// database (`first_messages`) until each is answered. A launch answers once the chat and its session are there; its
// first message goes after that (once a new worktree's dependencies are in),
// so a create resent after a restart finds its chat (`launchCommandId`) and is
// answered as made, while the message it was made for went with the process.
// Kept here first, whole (its pictures in files beside the database) and
// committed before the launch answers, it is sent at the next start under the command
// id it was meant to go under, through the chat's ordinary send (which
// resumes a chat at rest): one that went before the stop is answered from the
// chat's receipt, and runs no second turn.
//
// One is let go of only once the chat has answered it for good: taken, or
// refused in an answer its log keeps (`firstMessageSettled`). A refusal the
// log did not keep (the chat busy, its agent not starting, a failure on the
// way) leaves it kept, and it goes again at the next start.
//
// A scheduled run keeps its own record (`ScheduledRunRecord`).

/** The file builds before the database kept them in, under the data folder; read once, by the import. */
export const FIRST_MESSAGES_FILENAME = 'conversation-first-messages.json'

/** The folder under the data folder their pictures are kept in, one folder per message. */
export const FIRST_MESSAGE_IMAGES_DIRNAME = 'conversation-first-messages'

/** Who sends one again at start, to the conversation host: Studio itself. */
export const FIRST_MESSAGE_CLIENT_ID = 'studio-first-messages'

/** A picture a first message carries, kept as a file of its own beside the list. */
export type PendingFirstMessageImage = {
  /** Its file in the message's own folder. */
  file: string
  mediaType: string
  name?: string
  byteLength: number
}

/** One first message, as it is sent. */
export type PendingFirstMessage = {
  /** The id its launch stamped on the chat (`AgentState.launchCommandId`), which finds the chat again. */
  launchCommandId: string
  message: string
  skills?: string[]
  mode?: 'plan' | 'ask'
  /** Sent as the agent's own task to a sub-agent, rather than as the person's words. */
  subagentTask?: true
  /**
   * Who sent it when nobody typed it (an agent's, an extension's or a
   * schedule's launch): sent again, it meets the extensions' prompt hooks as
   * a `recovery`. Absent, a person typed it, and it is never hooked.
   */
  from?: 'studio' | 'extension' | 'agent'
  /** Its pictures, written to the disk before it was listed. */
  images?: PendingFirstMessageImage[]
  /** When it was kept, for the diagnostics. */
  at: number
}

export type PendingFirstMessages = {
  /**
   * Write it down, pictures included, under the command id it goes under,
   * committed before this resolves: the launch answers only after.
   */
  keep(
    commandId: string,
    message: Omit<PendingFirstMessage, 'images'>,
    attachments?: ConversationImageAttachment[],
  ): Promise<void>
  /** Let it go, with its pictures, once the chat has answered it for good. */
  done(commandId: string): Promise<void>
  /** Every one still kept. */
  all(): Promise<Record<string, PendingFirstMessage>>
  /** Where a kept message's picture lies on this disk. */
  imagePath(commandId: string, image: PendingFirstMessageImage): string
  /**
   * Remove the picture folders no kept message names: ones a stop left
   * between writing them and keeping the message, or between letting the
   * message go and removing them. Resolves to how many went.
   */
  sweep(): Promise<number>
}

/**
 * What the file builds before the database kept them in says, as they wrote
 * it; null for a file that is not that.
 */
export function readFirstMessagesFile(raw: string): Record<string, PendingFirstMessage> | null {
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown } | null
    if (!parsed || typeof parsed.messages !== 'object' || !parsed.messages || Array.isArray(parsed.messages))
      return null
    const messages: Record<string, PendingFirstMessage> = {}
    for (const [commandId, message] of Object.entries(parsed.messages as Record<string, unknown>)) {
      const read = readPendingFirstMessage(message)
      if (read) messages[commandId] = read
    }
    return messages
  } catch {
    return null
  }
}

/** One kept message, held to the fields it is sent with; null for one that is not that. */
function readPendingFirstMessage(value: unknown): PendingFirstMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<PendingFirstMessage>
  if (typeof message.launchCommandId !== 'string' || typeof message.message !== 'string') return null
  return { ...message, at: typeof message.at === 'number' ? message.at : 0 } as PendingFirstMessage
}

export function createPendingFirstMessages(options: {
  database: StudioDatabase
  /** Where their pictures are kept: `<data>/conversation-first-messages`. */
  imagesRoot: string
  warn?: (message: string) => void
}): PendingFirstMessages {
  const db = options.database
  const folderOf = (commandId: string) =>
    join(options.imagesRoot, createHash('sha256').update(commandId).digest('hex').slice(0, 32))
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => undefined)
    return next
  }

  async function kept(commandId: string): Promise<PendingFirstMessage | null> {
    const row = await db.get<{ body: string }>('SELECT body FROM first_messages WHERE command_id = ?', [commandId])
    return row ? parseBody(commandId, row.body) : null
  }

  function parseBody(commandId: string, body: string): PendingFirstMessage | null {
    try {
      const message = readPendingFirstMessage(JSON.parse(body))
      if (message) return message
    } catch {
      // Said below.
    }
    // Left in place rather than deleted: it is the owner's to look at.
    options.warn?.(`The first message kept for the launch ${commandId} does not read, so it is not sent.`)
    return null
  }

  return {
    keep: (commandId, message, attachments = []) =>
      serial(async () => {
        // The pictures first, each flushed: once the row names them they are there.
        const images: PendingFirstMessageImage[] = []
        if (attachments.length) {
          const folder = folderOf(commandId)
          await mkdir(folder, { recursive: true, mode: 0o700 })
          for (const [index, attachment] of attachments.entries()) {
            const file = `${index}`
            await writeFileAtomic(join(folder, file), Buffer.from(attachment.dataBase64, 'base64'), {
              mode: 0o600,
              durable: true,
            })
            images.push({
              file,
              mediaType: attachment.mediaType,
              ...(attachment.name ? { name: attachment.name } : {}),
              byteLength: attachment.byteLength,
            })
          }
        }
        const body: PendingFirstMessage = { ...message, ...(images.length ? { images } : {}) }
        await db.run(
          'INSERT INTO first_messages (command_id, body) VALUES (?, ?) ON CONFLICT (command_id) DO UPDATE SET body = excluded.body',
          [commandId, JSON.stringify(body)],
        )
      }),
    done: (commandId) =>
      serial(async () => {
        const message = await kept(commandId)
        const { changes } = await db.run('DELETE FROM first_messages WHERE command_id = ?', [commandId])
        if (changes && message?.images?.length)
          await rm(folderOf(commandId), { recursive: true, force: true }).catch(() => undefined)
      }),
    all: () =>
      serial(async () => {
        const rows = await db.all<{ command_id: string; body: string }>(
          'SELECT command_id, body FROM first_messages ORDER BY rowid',
        )
        const messages: Record<string, PendingFirstMessage> = {}
        for (const row of rows) {
          const message = parseBody(row.command_id, row.body)
          if (message) messages[row.command_id] = message
        }
        return messages
      }),
    imagePath: (commandId, image) => join(folderOf(commandId), image.file),
    // In the same line as `keep` and `done`, so a message being kept has its row by the time this looks.
    sweep: () =>
      serial(async () => {
        const names = await readdir(options.imagesRoot).catch(() => [] as string[])
        if (names.length === 0) return 0
        const rows = await db.all<{ command_id: string }>('SELECT command_id FROM first_messages')
        const named = new Set(rows.map((row) => basename(folderOf(row.command_id))))
        let removed = 0
        for (const name of names) {
          if (named.has(name) || !/^[0-9a-f]{32}$/u.test(name)) continue
          await rm(join(options.imagesRoot, name), { recursive: true, force: true })
          removed += 1
        }
        return removed
      }),
  }
}

export type FirstMessageChat = { workspaceId: string; agentId: string }

/** How a chat answered a first message's send: `code` and `recorded` as the chat said them. */
export type FirstMessageSendResult = { ok: true } | { ok: false; message: string; code?: string }

/**
 * Whether a send's answer settles a first message for good: the chat took
 * it, or another command holds its id, or an extension refused it (its last
 * word: sent again, it would be refused again), or it refused it in an answer
 * its log keeps (`answered`, asked only then). A refusal the log did not keep (busy,
 * an agent that would not start, a failure on the way) settles nothing: the
 * message is kept, and goes again.
 */
export async function firstMessageSettled(
  sent: FirstMessageSendResult,
  answered: () => Promise<boolean>,
): Promise<boolean> {
  if (sent.ok || sent.code === 'command_id_conflict' || sent.code === 'refused_by_extension') return true
  if (sent.code === 'busy') return false
  return answered().catch(() => false)
}

/**
 * Send every first message the last process kept and did not see answered.
 * One whose chat is gone (deleted since, or never made) is let go of; one
 * refused in a way that settles nothing is kept for the next start.
 * Resolves once each has been answered.
 */
export async function recoverFirstMessages(deps: {
  store: PendingFirstMessages
  findChat: (launchCommandId: string) => FirstMessageChat | null
  send: (chat: FirstMessageChat, commandId: string, message: PendingFirstMessage) => Promise<FirstMessageSendResult>
  /** Whether the chat's log keeps an answer to `commandId`: a refusal it recorded is the chat's last word. */
  answered: (chat: FirstMessageChat, commandId: string) => Promise<boolean>
  warn: (message: string) => void
}): Promise<void> {
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const sends: Promise<void>[] = []
  for (const [commandId, message] of Object.entries(await deps.store.all())) {
    const chat = deps.findChat(message.launchCommandId)
    if (!chat) {
      await deps.store.done(commandId)
      continue
    }
    sends.push(
      deps
        .send(chat, commandId, message)
        .catch((error: unknown): FirstMessageSendResult => ({ ok: false, message: describe(error) }))
        .then(async (sent) => {
          if (!(await firstMessageSettled(sent, () => deps.answered(chat, commandId)))) {
            deps.warn(
              `The first message of chat "${chat.agentId}", cut off by Studio stopping, could not be sent yet; it is sent again at the next start: ${sent.ok ? '' : sent.message}`,
            )
            return
          }
          if (!sent.ok)
            deps.warn(
              `The first message of chat "${chat.agentId}", cut off by Studio stopping, was refused: ${sent.message}`,
            )
          await deps.store.done(commandId)
        })
        .catch((error: unknown) =>
          deps.warn(`A first message cut off by Studio stopping could not be finished: ${describe(error)}`),
        ),
    )
  }
  await Promise.all(sends)
}

/** The command id a launch's first message goes under: its launch's, so a resent create names the same one. */
export function firstMessageCommandId(launchCommandId: string): string {
  return `${launchCommandId}:first`
}

/**
 * What a first message sent again after a stop is, for the extensions' prompt
 * hooks: a `recovery` from whoever sent it, when nobody typed it; nothing for
 * a person's own words, which no hook ever sees.
 */
export function recoveryHookAs(message: Pick<PendingFirstMessage, 'from'>): ConversationPromptHookAs | undefined {
  return message.from ? { inputKind: 'recovery', from: message.from } : undefined
}
