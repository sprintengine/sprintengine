import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import { OWN_SETTLE_GRACE_MS } from './conversation-lifecycle'

// An agent compacting its own chat (`conversation.compact`). The case it is
// for: an agent about to wait a long while (a CI run, a review, a slow build)
// would come back to a prompt cache that went cold, and its next turn would
// re-read the whole conversation at full price. Compacted first, while the
// cache is still warm, it comes back to a summary instead.
//
// The agent asks from inside its own turn, and a compaction cannot run in the
// middle of one: Claude Code and Codex each run `/compact` as a turn of its
// own. So the request is held until the asking agent's turn completes and
// then sent through the same door as the auto compaction before a cache
// expires (`studio-auto-compact.ts`): the CLI's own `/compact`, as Studio's
// message (`origin.reason` 'agent-compact'), which the chat draws as its
// compaction divider, "at the agent's request", and nothing more. It is let go, as a settle the agent asked for is
// (conversation-lifecycle.ts), when the chat moves on first: the turn fails or
// is stopped, a message reaches the chat, a new turn starts, or the session
// closes. Background work the turn left running (a monitor, a shell waiting
// on CI) does not hold it back: waiting on that work is the reason to compact.
//
// In memory only: a restart ends the turn it waits on, and the request with it.

/** The CLIs whose chats run a compaction of their own, as `/compact`. */
export const SELF_COMPACT_CLIS: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export type SelfCompactDeps = {
  /** The caller's own chat session here, or null when it has none (an agent in a terminal, or no agent at all). */
  sessionOf(workspaceId: string, agentId: string): ConversationSessionSummary | null
  /** Whether a message is waiting on the end of a turn in the workspace (a queued or scheduled one). */
  messageWaiting?(workspaceId: string): boolean
  /** Send the CLI's `/compact` to the session, as Studio's own message. */
  send(session: ConversationSessionSummary, commandId: string): Promise<{ ok: boolean; message?: string }>
  /** Run `job` after `ms`; returns the cancel. Injected so tests drive the clock. */
  schedule?: (job: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export type SelfCompactFailure = {
  ok: false
  code: 'not_an_agent' | 'not_a_chat' | 'cannot_compact' | 'send_failed'
  message: string
}

export type SelfCompactResult =
  | { ok: true; workspaceId: string; agentId: string; cli: string; compactsWhenTurnEnds: true }
  | { ok: true; workspaceId: string; agentId: string; cli: string; compacting: true }
  | SelfCompactFailure

type Pending = {
  workspaceId: string
  agentId: string
  /** The cancel of the grace's timer, once the turn has ended. */
  cancel: (() => void) | null
}

/**
 * Whether a turn of the session is under way: starting, running, or stopped on
 * the person's answer. Not the work a finished turn left running in the
 * background, which a compaction does not wait for.
 */
function turnRunning(session: ConversationSessionSummary): boolean {
  if (session.status === 'starting' || session.status === 'active' || session.status === 'awaiting_approval')
    return true
  const phase = session.phase
  return (
    phase === 'starting' || phase === 'running' || phase === 'waiting_for_approval' || phase === 'waiting_for_input'
  )
}

export type ConversationSelfCompact = ReturnType<typeof createConversationSelfCompact>

export function createConversationSelfCompact(deps: SelfCompactDeps) {
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  // By session id.
  const pending = new Map<string, Pending>()
  let sent = 0

  const drop = (sessionId: string): void => {
    pending.get(sessionId)?.cancel?.()
    pending.delete(sessionId)
  }

  const sendNow = (session: ConversationSessionSummary): Promise<{ ok: boolean; message?: string }> =>
    deps.send(session, `self-compact:${session.sessionId}:${Date.now()}:${(sent += 1)}`).catch((error: unknown) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))

  /**
   * The calling agent asks to compact its own chat. `caller` is the agent the
   * request came from, or null when it came from no agent of this app.
   */
  async function request(caller: { workspaceId: string; agentId: string } | null): Promise<SelfCompactResult> {
    if (!caller)
      return {
        ok: false,
        code: 'not_an_agent',
        message: 'Only an agent of this app compacts its own chat, and this call came from none.',
      }
    const session = deps.sessionOf(caller.workspaceId, caller.agentId)
    if (!session)
      return {
        ok: false,
        code: 'not_a_chat',
        message:
          'Your conversation is not a chat here (an agent in a terminal, or a chat that has ended), so Studio cannot compact it. Run your CLI’s own compaction instead, if it has one.',
      }
    const cli = cliForConversationProvider(session.providerId) ?? session.providerId
    if (!SELF_COMPACT_CLIS.has(cli))
      return {
        ok: false,
        code: 'cannot_compact',
        message: `This chat runs ${cli}, which has no compaction Studio can run. Only Claude Code and Codex chats compact.`,
      }
    const answer = { workspaceId: caller.workspaceId, agentId: caller.agentId, cli }
    // Mid-turn, as an agent asking always is: held for the turn's end. The
    // same agent asking again is told the same.
    if (pending.has(session.sessionId) || turnRunning(session)) {
      if (!pending.has(session.sessionId))
        pending.set(session.sessionId, { workspaceId: caller.workspaceId, agentId: caller.agentId, cancel: null })
      return { ok: true, ...answer, compactsWhenTurnEnds: true }
    }
    // Between turns (a call no turn of the chat made): sent now.
    const sentNow = await sendNow(session)
    if (!sentNow.ok)
      return { ok: false, code: 'send_failed', message: sentNow.message ?? 'The compaction could not be sent.' }
    return { ok: true, ...answer, compacting: true }
  }

  /** Carry out a held compaction once its agent's turn completes, or let it go when the chat moves on first. */
  function onConversationEvent(event: ConversationEvent): void {
    const waiting = pending.get(event.sessionId)
    if (!waiting) return
    switch (event.type) {
      case 'user_message':
        // The person's message, one steered into the turn, or one a paired
        // machine queued: the chat has more to do than wait.
        drop(event.sessionId)
        return
      case 'turn_started':
        // The asking turn had started before it asked; one starting after it ended is new work.
        if (waiting.cancel) drop(event.sessionId)
        return
      case 'turn_failed':
      case 'session_closed':
        drop(event.sessionId)
        return
      case 'turn_completed':
        // A turn a steered message ended goes straight on, and that message has let it go already.
        if (event.payload?.steered === true || waiting.cancel) return
        waiting.cancel = schedule(() => {
          if (pending.get(event.sessionId) !== waiting) return
          pending.delete(event.sessionId)
          if (deps.messageWaiting?.(waiting.workspaceId)) {
            deps.log?.('A chat its agent asked to compact was left as it is: a message waits to go in.')
            return
          }
          const session = deps.sessionOf(waiting.workspaceId, waiting.agentId)
          if (!session || session.sessionId !== event.sessionId || turnRunning(session)) {
            deps.log?.('A chat its agent asked to compact was left as it is: it had moved on.')
            return
          }
          void sendNow(session).then((answer) => {
            if (!answer.ok)
              deps.log?.(`A chat its agent asked to compact was not compacted: ${answer.message ?? 'refused'}`)
          })
        }, OWN_SETTLE_GRACE_MS)
        return
    }
  }

  return {
    request,
    onConversationEvent,
    /** Whether a compaction waits on the session's turn. Exposed for tests. */
    compactsWhenTurnEnds: (sessionId: string) => pending.has(sessionId),
  }
}
