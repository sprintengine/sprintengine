import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { conversationTurnInProgress } from '../../shared/conversation/phase'
import { composePullRequestWake } from './pull-request-watch'
import type {
  PullRequestConversationKey,
  PullRequestUntoldSource,
  PullRequestWatchNewsEvent,
} from './pull-request-record'

// Waking a chat about the pull request its agent asked Studio to watch.
//
// The watch (`pull-request-watch.ts`) decides what is news; this says it in
// the chat, through the chat's normal send path (the one a paired device's
// send and a resume after a usage limit take), which resumes a chat with no
// live session from its record. The message is recorded as Studio's, not the
// person's (`origin` on its `user_message`, reason `pull-request-watch`), so
// the chat draws it as Studio's row and nothing counts it as the person
// writing; its words open with Studio's name for the agent, which reads only
// words.
//
// When it goes, and when it does not:
//
// - Never into a settled or deleted chat. The person put it away, and waking
//   its agent would bring it back; the watch stops instead (`onChatGone`).
// - Never into a running turn, or over a question or an approval the person
//   has not answered. It waits for the turn to end and goes then; the chat
//   carries on with its work, and the news is the next thing it reads. A chat
//   send never touches the composer, so a draft the person is writing stays
//   theirs.
// - Not into a usage limit: a turn started then would fail. It waits until a
//   little after the limit resets.
// - One message per wake: everything every watch of the chat learned while
//   it waited is folded into one, newest news last.
//
// What is waiting is the record's (`untold`, pull-request-untold.ts), stored
// in the same write as the watch state that found it, so a restart neither
// loses news the watch has moved past nor says it twice: a message goes under
// a command id stamped on what it carries before it is sent, the chat's
// receipt answers a repeat of it, and the news leaves once the chat answers.

/** After a chat's turn ends, before the wake goes: the runtime lets go of the turn just after it says so. */
const TURN_END_SETTLE_MS = 1_500
/** A busy chat is looked at again after this, if its turn's end is not heard first. */
const BUSY_RETRY_MS = 60_000
/** After a usage limit resets, before the wake goes: past the chat's own resume, which is the better first message. */
const AFTER_RESET_MS = 2 * 60_000
/** A limit with no known reset is looked at again after this. */
const LIMIT_RETRY_MS = 5 * 60_000
/** A timer longer than this is armed again rather than trusted (sleep, a changed clock). */
const MAX_TIMER_MS = 15 * 60_000

export type PullRequestWakeSendResult = { ok: boolean; code?: string; message?: string; retryAfterMs?: number }

export type PullRequestWakesDeps = {
  listSessions(): ConversationSessionSummary[]
  onConversationEvent(listener: (event: ConversationEvent) => void): () => void
  /** The chat as its record says: null once deleted; `settled` once the person put it away. */
  chat(key: PullRequestConversationKey): { settled: boolean } | null
  /** Send a turn through the chat's normal send path, marked as Studio's. */
  send(key: PullRequestConversationKey, text: string, commandId: string): Promise<PullRequestWakeSendResult>
  /** The news chats have not been told, kept by the record. */
  untold: PullRequestUntoldSource
  /** Whether a chat provider is out of its plan's usage now, and when that lifts. Absent, nothing waits on a limit. */
  usageLimit?(providerId: string): { limited: boolean; resetsAt: number | null }
  /** The chat is deleted or put away: its watches stop, and nothing is said. */
  onChatGone(key: PullRequestConversationKey): void
  now?(): number
  setTimer?(callback: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  log?(message: string): void
}

export type PullRequestWakes = {
  /** News for a chat, already kept as untold: said now if it takes a message, else as soon as it does. */
  deliver(event: PullRequestWatchNewsEvent): void
  /** At start: the chats the last run left news for are looked at as if it had just come. */
  resume(): Promise<void>
  /** The computer woke or was unlocked: timers stood still while it slept. */
  wake(): void
  dispose(): void
}

type Waiting = {
  key: PullRequestConversationKey
  sending: boolean
  /** News came while a message was out: looked at again once it is answered. */
  again: boolean
  timer: unknown
  /** When the armed timer is due, so a sooner look replaces a later one and not the other way round. */
  timerAt: number
}

const idOf = (key: PullRequestConversationKey) => `${key.workspaceId}\0${key.agentId}`

export function createPullRequestWakes(deps: PullRequestWakesDeps): PullRequestWakes {
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const waiting = new Map<string, Waiting>()
  let disposed = false

  const stopListening = deps.onConversationEvent((event) => {
    if (event.type !== 'turn_completed' && event.type !== 'turn_failed') return
    const entry = waiting.get(idOf(event))
    if (entry) lookAgainIn(entry, TURN_END_SETTLE_MS)
  })

  /** A chat has news: looked at now, or once the message out to it is answered. */
  function lookAt(key: PullRequestConversationKey): void {
    if (disposed) return
    const id = idOf(key)
    const entry = waiting.get(id) ?? { key: { ...key }, sending: false, again: false, timer: null, timerAt: 0 }
    waiting.set(id, entry)
    if (entry.sending) entry.again = true
    void flush(entry)
  }

  function lookAgainIn(entry: Waiting, ms: number): void {
    const at = now() + ms
    if (entry.timer !== null && entry.timerAt <= at) return
    if (entry.timer !== null) clearTimer(entry.timer)
    entry.timerAt = at
    entry.timer = setTimer(
      () => {
        entry.timer = null
        if (now() < entry.timerAt) return lookAgainIn(entry, entry.timerAt - now())
        void flush(entry)
      },
      Math.max(0, Math.min(ms, MAX_TIMER_MS)),
    )
  }

  function drop(entry: Waiting): void {
    if (entry.timer !== null) clearTimer(entry.timer)
    entry.timer = null
    waiting.delete(idOf(entry.key))
  }

  async function flush(entry: Waiting): Promise<void> {
    if (disposed || entry.sending || waiting.get(idOf(entry.key)) !== entry) return
    const chat = deps.chat(entry.key)
    if (!chat || chat.settled) {
      drop(entry)
      deps.untold.forget(entry.key)
      deps.onChatGone(entry.key)
      return
    }
    const sessions = deps
      .listSessions()
      .filter((session) => session.workspaceId === entry.key.workspaceId && session.agentId === entry.key.agentId)
    // A turn running, or stopped on the person: the news is the next thing it reads.
    if (sessions.some((session) => session.status !== 'stopped' && conversationTurnInProgress(session))) {
      lookAgainIn(entry, BUSY_RETRY_MS)
      return
    }
    const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const limit = latest && deps.usageLimit ? deps.usageLimit(latest.providerId) : null
    if (limit?.limited) {
      lookAgainIn(
        entry,
        limit.resetsAt === null ? LIMIT_RETRY_MS : Math.max(0, limit.resetsAt - now()) + AFTER_RESET_MS,
      )
      return
    }

    entry.sending = true
    entry.again = false
    let result: PullRequestWakeSendResult
    let message: Awaited<ReturnType<PullRequestUntoldSource['next']>> = null
    try {
      // The message a send already went out under, or everything not told
      // yet under a new id, written before it goes.
      message = await deps.untold.next(entry.key)
    } catch (error) {
      // Its id could not be written: nothing goes until it can be.
      entry.sending = false
      deps.log?.(
        `A pull request wake waits for its record to be written: ${error instanceof Error ? error.message : error}`,
      )
      if (!disposed) lookAgainIn(entry, BUSY_RETRY_MS)
      return
    }
    try {
      result =
        message && !disposed
          ? await deps.send(entry.key, composePullRequestWake(message.wakes), message.commandId)
          : { ok: true }
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      entry.sending = false
    }
    if (disposed) return
    if (!message) {
      if (entry.again) void flush(entry)
      else drop(entry)
      return
    }
    // A turn that started between the look and the send: the same message,
    // under the same id, goes when it ends.
    if (!result.ok && result.code === 'busy') {
      lookAgainIn(entry, Math.max(BUSY_RETRY_MS, result.retryAfterMs ?? 0))
      return
    }
    if (!result.ok)
      deps.log?.(`A pull request watch could not wake its chat: ${result.message ?? 'the chat refused it'}`)
    deps.untold.told(entry.key, message.commandId)
    // News that came while the send was out goes in a message of its own.
    void flush(entry)
  }

  return {
    deliver: (event) => lookAt(event.conversation),
    async resume() {
      // A chat the records do not name yet (they may still be loading) keeps
      // its news for the next start, rather than being taken for deleted.
      for (const key of await deps.untold.chats()) if (deps.chat(key)) lookAt(key)
    },
    wake() {
      for (const entry of waiting.values()) {
        if (entry.timer === null) continue
        clearTimer(entry.timer)
        entry.timer = null
        void flush(entry)
      }
    },
    dispose() {
      disposed = true
      stopListening()
      for (const entry of waiting.values()) if (entry.timer !== null) clearTimer(entry.timer)
      waiting.clear()
    },
  }
}
