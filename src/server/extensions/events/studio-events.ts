import {
  EXTENSION_EVENT_TERMINALS_MAX,
  type ExtensionAgentState,
  type ExtensionEventPayloads,
  type ExtensionEventWorkspace,
} from '../../../../packages/extension-sdk/src/events'
import type { TerminalSessionSnapshot } from '../../../../packages/studio-protocol/src/terminals'
import type { AgentPhase } from '../../../../packages/studio-protocol/src/terminals'
import type { AgentPhaseEvent } from '../../../shared/agent-runtime'
import {
  isStudioCompactionReason,
  readConversationMessageOrigin,
  type ConversationEvent,
} from '../../../shared/conversation-runtime'
import { isTurnlessSubagentStep } from '../../../shared/conversation/subagents'
import { isInterruptedTurnEnd } from '../../../main/conversation-attention'
import type { ExtensionEvents } from './extension-events'

// Where Studio's own state becomes its extensions' events (extension-events.ts
// carries them on). Every source is read here, once per change, and only while
// something listens for what it would say:
//
// - the workspaces: each commit of the registry, whoever made it (a window, an
//   agent, an extension, a schedule), and each change of the live terminals,
//   compared with what was last seen: a workspace that appeared is
//   `workspace.created`, one gone `workspace.removed`, one whose name,
//   folder, branch or terminals changed `workspace.changed`;
// - the agents: a chat's state, read from its own events (`chatStatusOf`: a
//   failed turn is failed, a closed chat is done), and a terminal agent's
//   (from its reporter), told once per change of state, not for every step,
//   and `done` once.

/** A workspace as the registry holds it: the parts the events read. */
export type StudioEventWorkspaceRecord = {
  id: string
  name: string
  folderPath: string | null
  worktree?: { branch?: string | null } | null
  agents?: Record<string, { name?: string } | undefined>
}

export type StudioEventSources = {
  workspaces: {
    records(): readonly StudioEventWorkspaceRecord[]
    /** Every committed change; returns the unsubscriber. */
    subscribe(listener: () => void): () => void
  }
  /** The live terminals; null where this Studio runs none. */
  terminals: {
    list(): readonly TerminalSessionSnapshot[]
    onChanged(listener: () => void): () => void
    onAgentPhase(listener: (event: AgentPhaseEvent) => void): () => void
  } | null
  /** Every chat's events, as they happen; returns the unsubscriber. */
  onChatEvent(listener: (event: ConversationEvent) => void): () => void
  /** The title an extension gave a terminal it opened, or null. */
  terminalTitle?(terminalId: string): string | null
  now?: () => number
}

type WorkspaceView = ExtensionEventPayloads['workspace.changed']['workspace']

function workspaceOf(record: StudioEventWorkspaceRecord): ExtensionEventWorkspace {
  return {
    workspaceId: record.id,
    name: record.name,
    kind: record.worktree ? 'worktree' : 'folder',
    folderPath: record.folderPath ?? null,
    branch: record.worktree?.branch ?? null,
  }
}

/** A terminal agent's or a chat's phase, as the events say it. */
export function agentStateOf(phase: AgentPhase): { state: ExtensionAgentState; failed: boolean } {
  switch (phase) {
    case 'awaiting_input':
      return { state: 'blocked', failed: false }
    case 'idle':
    case 'exited':
      return { state: 'done', failed: false }
    case 'failed':
      return { state: 'done', failed: true }
    default:
      // starting, thinking, tool_use, stalled: still at it.
      return { state: 'working', failed: false }
  }
}

/** An agent's state as the events say it, with whether it is gone for good (a closed chat, an exited process). */
export type AgentStatus = {
  workspaceId: string | null
  agentId: string
  state: ExtensionAgentState
  failed: boolean
  gone: boolean
}

/**
 * A chat's state from its own events. Not the attention listener's phases,
 * which are made for a badge: they read a failed turn as idle and a close as
 * working again. Here a failed turn is `done, failed` (one the person
 * stopped is not a failure), a close is `done` and the chat's last word, and
 * a turn Studio opened for its own compaction is no change at all.
 */
export function chatStatusOf(): (event: ConversationEvent) => AgentStatus | null {
  // Approvals outstanding by session; a session forgotten once none are.
  const pending = new Map<string, Set<string>>()
  // The turn Studio opened in a session for its own `/compact`, until it ends.
  const quietTurns = new Map<string, string>()
  return (event) => {
    const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : undefined
    if (
      event.type === 'user_message' &&
      turnId &&
      isStudioCompactionReason(readConversationMessageOrigin(event.payload?.origin)?.reason)
    )
      quietTurns.set(event.sessionId, turnId)
    const quiet = quietTurns.get(event.sessionId)
    if (quiet !== undefined && quiet === turnId) {
      if (event.type === 'turn_completed' || event.type === 'turn_failed') quietTurns.delete(event.sessionId)
      return null
    }
    const waiting = pending.get(event.sessionId)
    const say = (state: ExtensionAgentState, failed = false, gone = false): AgentStatus => ({
      workspaceId: event.workspaceId,
      agentId: event.agentId,
      state,
      failed,
      gone,
    })
    switch (event.type) {
      case 'session_started':
      case 'user_message':
      case 'turn_started':
        return waiting?.size ? null : say('working')
      case 'tool_started':
        if (waiting?.size || isTurnlessSubagentStep(event)) return null
        return say('working')
      case 'approval_requested': {
        if (event.payload?.autoApproved === true || typeof event.payload?.requestId !== 'string') return null
        const set = waiting ?? new Set<string>()
        set.add(event.payload.requestId)
        pending.set(event.sessionId, set)
        return say('blocked')
      }
      case 'approval_resolved': {
        if (typeof event.payload?.requestId !== 'string' || !waiting?.delete(event.payload.requestId)) return null
        if (waiting.size) return null
        pending.delete(event.sessionId)
        return say('working')
      }
      case 'turn_completed':
      case 'turn_failed':
        // A turn a steered message ended: the agent carries straight on.
        if (event.payload?.steered === true) return null
        pending.delete(event.sessionId)
        return say('done', event.type === 'turn_failed' && !isInterruptedTurnEnd(event))
      case 'session_closed':
        pending.delete(event.sessionId)
        quietTurns.delete(event.sessionId)
        return say('done', false, true)
      default:
        return null
    }
  }
}

/** A terminal agent's reported phase, as the events say it: its failure flag read beside its phase. */
export function terminalStatusOf(event: AgentPhaseEvent): AgentStatus {
  const { state, failed } = agentStateOf(event.phase)
  return {
    workspaceId: event.workspaceId,
    agentId: event.agentId,
    state,
    failed: failed || (state === 'done' && event.turnFailure === true),
    gone: event.phase === 'exited',
  }
}

/** The most agents whose last state is remembered; past it, the longest-quiet is forgotten. */
const AGENT_STATES_KEPT = 4096

/** Follow Studio's state and say what changed to the extensions that listen. Returns the stop. */
export function followStudioEvents(events: ExtensionEvents, sources: StudioEventSources): () => void {
  const now = sources.now ?? (() => Date.now())
  const stops: Array<() => void> = []

  // ── Workspaces ──
  const terminalsOf = (
    workspaceId: string,
    sessions: readonly TerminalSessionSnapshot[],
    record: StudioEventWorkspaceRecord,
  ) =>
    sessions
      .filter((session) => session.workspaceId === workspaceId && session.processAlive)
      .slice(0, EXTENSION_EVENT_TERMINALS_MAX)
      .map((session) => ({
        id: session.sessionId,
        title:
          (session.agentId ? record.agents?.[session.agentId]?.name : undefined) ??
          session.agentName ??
          sources.terminalTitle?.(session.sessionId) ??
          null,
      }))
  const snapshot = (): Map<string, WorkspaceView> => {
    const sessions = sources.terminals?.list() ?? []
    return new Map(
      sources.workspaces
        .records()
        .map((record) => [record.id, { ...workspaceOf(record), terminals: terminalsOf(record.id, sessions, record) }]),
    )
  }
  // What was last seen, kept whether or not anything listens (a few small
  // records per workspace), so the first listener hears the first change.
  let seen = new Map<string, string>()
  let seenViews = new Map<string, WorkspaceView>()
  let started = false
  const compare = () => {
    const views = snapshot()
    const keys = new Map([...views].map(([id, view]) => [id, JSON.stringify(view)]))
    if (started) {
      for (const [id, view] of views) {
        const before = seen.get(id)
        if (before === undefined) {
          if (events.wants('workspace.created')) events.emit('workspace.created', workspaceOf(viewRecord(view)))
        } else if (before !== keys.get(id) && events.wants('workspace.changed'))
          events.emit('workspace.changed', { workspace: view })
      }
      for (const [id, view] of seenViews)
        if (!views.has(id) && events.wants('workspace.removed'))
          events.emit('workspace.removed', workspaceOf(viewRecord(view)))
    }
    started = true
    seen = keys
    seenViews = views
  }
  stops.push(sources.workspaces.subscribe(compare))
  if (sources.terminals) stops.push(sources.terminals.onChanged(compare))
  // What is there when Studio starts is no news.
  compare()

  // ── Agents ──
  // What each agent was last said to be. `done` is said once: a finished
  // agent's close (an exited process, a closed chat) says nothing more.
  const lastState = new Map<string, string>()
  const tell = (where: 'chat' | 'terminal', status: AgentStatus | null) => {
    if (!status) return
    const key = `${where}\0${status.workspaceId ?? ''}\0${status.agentId}`
    const before = lastState.get(key)
    const said = `${status.state}:${status.failed}`
    lastState.delete(key)
    if (!status.gone) {
      lastState.set(key, status.state === 'done' ? 'done' : said)
      if (lastState.size > AGENT_STATES_KEPT) lastState.delete(lastState.keys().next().value as string)
    }
    if (before === said || (before === 'done' && status.state === 'done')) return
    if (!events.wants('agent.status.changed')) return
    const record = sources.workspaces.records().find((candidate) => candidate.id === status.workspaceId)
    const terminal =
      where === 'terminal'
        ? (sources.terminals?.list() ?? []).find(
            (session) =>
              session.agentId === status.agentId && (!status.workspaceId || session.workspaceId === status.workspaceId),
          )
        : undefined
    events.emit('agent.status.changed', {
      workspaceId: status.workspaceId,
      agentId: status.agentId,
      where,
      terminalId: terminal?.sessionId ?? null,
      title: record?.agents?.[status.agentId]?.name ?? terminal?.agentName ?? null,
      state: status.state,
      failed: status.failed,
      receivedAt: now(),
    })
  }
  const chatStatus = chatStatusOf()
  stops.push(sources.onChatEvent((event) => tell('chat', chatStatus(event))))
  if (sources.terminals)
    stops.push(sources.terminals.onAgentPhase((event) => tell('terminal', terminalStatusOf(event))))

  return () => {
    for (const stop of stops.splice(0)) stop()
  }
}

function viewRecord(view: WorkspaceView): StudioEventWorkspaceRecord {
  return {
    id: view.workspaceId,
    name: view.name,
    folderPath: view.folderPath,
    worktree: view.kind === 'worktree' ? { branch: view.branch } : null,
  }
}
