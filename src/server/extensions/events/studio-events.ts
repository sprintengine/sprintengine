import {
  EXTENSION_EVENT_TERMINALS_MAX,
  type ExtensionAgentState,
  type ExtensionEventPayloads,
  type ExtensionEventWorkspace,
} from '../../../../packages/extension-sdk/src/events'
import type { TerminalSessionSnapshot } from '../../../../packages/studio-protocol/src/terminals'
import type { AgentPhase } from '../../../../packages/studio-protocol/src/terminals'
import type { AgentPhaseEvent } from '../../../shared/agent-runtime'
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
// - the agents: a chat's phase (as the attention listener reads it from its
//   events) and a terminal agent's (from its reporter), told once per change
//   of state, not for every step.

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
  /** A chat's phases, as the attention listener reads them from its events; returns the unsubscriber. */
  onChatPhase(listener: (event: AgentPhaseEvent) => void): () => void
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
  const lastState = new Map<string, string>()
  const phase = (where: 'chat' | 'terminal') => (event: AgentPhaseEvent) => {
    const key = `${event.workspaceId ?? ''}\0${event.agentId}`
    const { state, failed } = agentStateOf(event.phase)
    const said = `${state}:${failed}`
    if (lastState.get(key) === said) return
    lastState.set(key, said)
    if (state === 'done') lastState.delete(key)
    if (!events.wants('agent.status.changed')) return
    const record = sources.workspaces.records().find((candidate) => candidate.id === event.workspaceId)
    const terminal =
      where === 'terminal'
        ? (sources.terminals?.list() ?? []).find(
            (session) =>
              session.agentId === event.agentId && (!event.workspaceId || session.workspaceId === event.workspaceId),
          )
        : undefined
    events.emit('agent.status.changed', {
      workspaceId: event.workspaceId,
      agentId: event.agentId,
      where,
      terminalId: terminal?.sessionId ?? null,
      title: record?.agents?.[event.agentId]?.name ?? terminal?.agentName ?? null,
      state,
      failed,
      receivedAt: now(),
    })
  }
  stops.push(sources.onChatPhase(phase('chat')))
  if (sources.terminals) stops.push(sources.terminals.onAgentPhase(phase('terminal')))

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
