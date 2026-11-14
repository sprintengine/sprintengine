import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeFileAtomic } from '../server/platform/atomic-file'

// The first messages of chats a launch made, kept on disk until each is
// answered. A launch answers once the chat and its session are there; its
// first message goes after that (once a new worktree's dependencies are in),
// so a create resent after a restart finds its chat (`launchCommandId`) and is
// answered as made, while the message it was made for went with the process.
// Kept here first, it is sent at the next start under the command id it was
// meant to go under, through the chat's ordinary send (which resumes a chat
// at rest): one that went before the stop is answered from the chat's
// receipt, and runs no second turn.
//
// A scheduled run keeps its own record (`ScheduledRunRecord`), and a first
// message with pictures is not kept here: its bytes are not written down.

/** The file under the data directory they are kept in. */
export const FIRST_MESSAGES_FILENAME = 'conversation-first-messages.json'

/** Who sends one again at start, to the conversation host: Studio itself. */
export const FIRST_MESSAGE_CLIENT_ID = 'studio-first-messages'

/** One first message, as it is sent. */
export type PendingFirstMessage = {
  /** The id its launch stamped on the chat (`AgentState.launchCommandId`), which finds the chat again. */
  launchCommandId: string
  message: string
  skills?: string[]
  mode?: 'plan' | 'ask'
  /** Sent as the agent's own task to a sub-agent, rather than as the person's words. */
  subagentTask?: true
  /** When it was kept, for the diagnostics. */
  at: number
}

export type PendingFirstMessages = {
  /** Write it down under the command id it goes under, before the launch answers. */
  keep(commandId: string, message: PendingFirstMessage): Promise<void>
  /** Let it go once its send is answered, either way. */
  done(commandId: string): Promise<void>
  /** Every one still kept, read from disk once. */
  all(): Promise<Record<string, PendingFirstMessage>>
}

type FileShape = { v: 1; messages: Record<string, PendingFirstMessage> }

export function createPendingFirstMessages(options: {
  filePath: string
  warn?: (message: string) => void
}): PendingFirstMessages {
  let messages: Record<string, PendingFirstMessage> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work)
    queue = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Record<string, PendingFirstMessage>> {
    if (messages) return messages
    try {
      const parsed = JSON.parse(await readFile(options.filePath, 'utf8')) as Partial<FileShape>
      messages = parsed && typeof parsed.messages === 'object' && parsed.messages ? { ...parsed.messages } : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT')
        options.warn?.(
          `The first messages kept for new chats could not be read: ${error instanceof Error ? error.message : String(error)}`,
        )
      messages = {}
    }
    return messages
  }

  async function save(next: Record<string, PendingFirstMessage>): Promise<void> {
    await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(options.filePath, JSON.stringify({ v: 1, messages: next } satisfies FileShape), {
      mode: 0o600,
    })
  }

  return {
    keep: (commandId, message) =>
      serial(async () => {
        const kept = await load()
        kept[commandId] = message
        await save(kept)
      }),
    done: (commandId) =>
      serial(async () => {
        const kept = await load()
        if (!(commandId in kept)) return
        delete kept[commandId]
        await save(kept)
      }),
    all: () => serial(async () => ({ ...(await load()) })),
  }
}

export type FirstMessageChat = { workspaceId: string; agentId: string }

/**
 * Send every first message the last process kept and did not see answered.
 * One whose chat is gone (deleted since, or never made) is let go of.
 * Resolves once each has been answered.
 */
export async function recoverFirstMessages(deps: {
  store: PendingFirstMessages
  findChat: (launchCommandId: string) => FirstMessageChat | null
  send: (
    chat: FirstMessageChat,
    commandId: string,
    message: PendingFirstMessage,
  ) => Promise<{ ok: true } | { ok: false; message: string }>
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
        .catch((error: unknown) => ({ ok: false as const, message: describe(error) }))
        .then(async (sent) => {
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
