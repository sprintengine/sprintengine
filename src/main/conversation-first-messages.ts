import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ConversationImageAttachment } from '../shared/conversation-runtime'
import { writeFileAtomic } from '../server/platform/atomic-file'

// The first messages of chats a launch made, kept on disk until each is
// answered. A launch answers once the chat and its session are there; its
// first message goes after that (once a new worktree's dependencies are in),
// so a create resent after a restart finds its chat (`launchCommandId`) and is
// answered as made, while the message it was made for went with the process.
// Kept here first, whole (its pictures beside it) and flushed to the disk
// before the launch answers, it is sent at the next start under the command
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

/** The file under the data directory they are kept in; their pictures in the folder beside it, without `.json`. */
export const FIRST_MESSAGES_FILENAME = 'conversation-first-messages.json'

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
  /** Its pictures, written to the disk before it was listed. */
  images?: PendingFirstMessageImage[]
  /** When it was kept, for the diagnostics. */
  at: number
}

export type PendingFirstMessages = {
  /**
   * Write it down, pictures included, under the command id it goes under,
   * flushed to the disk before this resolves: the launch answers only after.
   */
  keep(
    commandId: string,
    message: Omit<PendingFirstMessage, 'images'>,
    attachments?: ConversationImageAttachment[],
  ): Promise<void>
  /** Let it go, with its pictures, once the chat has answered it for good. */
  done(commandId: string): Promise<void>
  /** Every one still kept, read from disk once. */
  all(): Promise<Record<string, PendingFirstMessage>>
  /** Where a kept message's picture lies on this disk. */
  imagePath(commandId: string, image: PendingFirstMessageImage): string
}

type FileShape = { v: 1; messages: Record<string, PendingFirstMessage> }

export function createPendingFirstMessages(options: {
  filePath: string
  warn?: (message: string) => void
  now?: () => number
}): PendingFirstMessages {
  const now = options.now ?? Date.now
  const imagesRoot = options.filePath.replace(/\.json$/u, '')
  const folderOf = (commandId: string) =>
    join(imagesRoot, createHash('sha256').update(commandId).digest('hex').slice(0, 32))
  let messages: Record<string, PendingFirstMessage> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Record<string, PendingFirstMessage>> {
    if (messages) return messages
    let raw: string
    try {
      raw = await readFile(options.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return (messages = {})
      // There but unreadable is not "none kept": written over, it would lose
      // every message it holds. Nothing is kept or let go of until it reads.
      throw new Error(
        `The first messages kept for new chats could not be read: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FileShape>
      if (parsed && typeof parsed.messages === 'object' && parsed.messages) return (messages = { ...parsed.messages })
    } catch {
      // Malformed: set aside below.
    }
    // Malformed: kept aside for the owner rather than written over.
    const aside = `${options.filePath}.unreadable-${now()}`
    await rename(options.filePath, aside)
    options.warn?.(`The first messages kept for new chats were not readable; the file was kept aside as ${aside}.`)
    return (messages = {})
  }

  async function save(next: Record<string, PendingFirstMessage>): Promise<void> {
    await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(options.filePath, JSON.stringify({ v: 1, messages: next } satisfies FileShape), {
      mode: 0o600,
      durable: true,
    })
  }

  return {
    keep: (commandId, message, attachments = []) =>
      serial(async () => {
        const kept = await load()
        // The pictures first, each flushed: once the list names them they are there.
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
        const next = { ...kept, [commandId]: { ...message, ...(images.length ? { images } : {}) } }
        await save(next)
        messages = next
      }),
    done: (commandId) =>
      serial(async () => {
        const kept = await load()
        if (!(commandId in kept)) return
        const next = { ...kept }
        const images = next[commandId]?.images?.length
        delete next[commandId]
        await save(next)
        messages = next
        if (images) await rm(folderOf(commandId), { recursive: true, force: true }).catch(() => undefined)
      }),
    all: () => serial(async () => ({ ...(await load()) })),
    imagePath: (commandId, image) => join(folderOf(commandId), image.file),
  }
}

export type FirstMessageChat = { workspaceId: string; agentId: string }

/** How a chat answered a first message's send: `code` and `recorded` as the chat said them. */
export type FirstMessageSendResult = { ok: true } | { ok: false; message: string; code?: string }

/**
 * Whether a send's answer settles a first message for good: the chat took
 * it, or another command holds its id, or it refused it in an answer its log
 * keeps (`answered`, asked only then). A refusal the log did not keep (busy,
 * an agent that would not start, a failure on the way) settles nothing: the
 * message is kept, and goes again.
 */
export async function firstMessageSettled(
  sent: FirstMessageSendResult,
  answered: () => Promise<boolean>,
): Promise<boolean> {
  if (sent.ok || sent.code === 'command_id_conflict') return true
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
