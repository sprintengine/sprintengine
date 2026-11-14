import type {
  WorkspaceLifecycleRequest,
  WorkspaceLifecycleResult,
  WorkspaceLifecycleSnapshot,
} from '../../../shared/workspace-lifecycle'
import type {
  WindowPlacement,
  WorkspaceFieldsPatch,
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from '../../../shared/workspace-sync'
import { agentPatchForWire } from '../../../shared/workspace-sync'
import type { AgentCli, AgentId, AgentState, Workspace, WorkspaceId, WorkspaceWindowId } from '../types/workspace'
import { workspaceSyncApi, workspaceSyncReachable, type WorkspaceSyncApi } from '../studio/workspaceSync'

// Defined locally (matching WorkspaceManager/workspacesSlice) so this adapter
// does not import a store slice, keeping the module dependency graph acyclic.
const PRIMARY_WORKSPACE_WINDOW_ID: WorkspaceWindowId = 'primary'

// Renderer-side adapter for the main-mediated workspace sync bus. It keeps
// WorkspaceManager and the store free of IPC mechanics: it dispatches scoped
// commands (active selection, workspace move, window close, placement), applies
// the accepted/broadcast events to the local store, and tracks the last applied
// sequence so duplicate or older events are ignored.
//
// Main owns the registry, so this client is the store's only route to
// it: the storage-event cross-window path it used to sit beside is gone with the
// localStorage registry. The store applies a user edit optimistically and asks
// through here; a rejection means main refused the write (a stale per-field
// last-write-wins edit, or a workspace another window removed) and carries the
// snapshot the store reconciles against, so a value main refused is never kept.

// The narrow slice of the window's registry calls this client depends on, so tests can inject a
// fake transport without constructing the full ElectronApi surface.
export type WorkspaceSyncClientApi = Pick<
  WorkspaceSyncApi,
  'workspaceSyncDispatch' | 'workspaceSyncGetSnapshot' | 'workspaceSyncGetEventsAfter' | 'onWorkspaceSyncEvent'
> &
  Partial<Pick<WorkspaceSyncApi, 'workspaceLifecycle'>>

// Local application of an active_changed event. `isCurrentWindow` is true only
// for the renderer that owns `windowId`; remote windows update the targeted
// window's record without claiming global active selection.
export type WorkspaceActiveChangedApply = {
  windowId: WorkspaceWindowId
  workspaceId: WorkspaceId | null
  createdAt: number
  isCurrentWindow: boolean
}

// Local application of a moved_to_window event. `isCurrentWindowTarget` is true
// only for the renderer that owns the destination window; only that renderer
// adopts the moved workspace as its global active selection.
export type WorkspaceMovedApply = {
  workspaceId: WorkspaceId
  fromWindowId: WorkspaceWindowId | null
  toWindowId: WorkspaceWindowId
  makeActive: boolean
  createdAt: number
  isCurrentWindowTarget: boolean
}

// Local application of a window-closed event. The fallback window inherits the
// recorded `movedWorkspaceIds`; receiving renderers route these without needing
// the closing window's full record.
export type WorkspaceClosedApply = {
  windowId: WorkspaceWindowId
  fallbackWindowId: WorkspaceWindowId
  movedWorkspaceIds: WorkspaceId[]
  createdAt: number
}

// Local application of a placement_updated event. Touches only the target
// window's placement fields, never workspace objects or membership.
export type WorkspacePlacementApply = WindowPlacement & {
  windowId: WorkspaceWindowId
  createdAt: number
}

// Local application of a workspace.created event. The workspace is inserted at
// its folder head and assigned to the target window; only the renderer that owns
// the target window claims the moved-in workspace as its global active.
export type WorkspaceCreatedApply = {
  workspace: Workspace
  windowId: WorkspaceWindowId
  folderPath: string | null
  createdAt: number
  isCurrentWindowTarget: boolean
  /** False: the workspace joins its window without being brought to the front (a scheduled run). */
  activate: boolean
}

export type AgentTerminalSessionApply = {
  workspaceId: WorkspaceId
  agentId: AgentId
  sessionId: string
  cli: AgentCli
  // Stamped main-side from the plugin registry (see workspace-sync-service);
  // the store applier stores these instead of re-deriving resume from `cli`.
  cliResumeAvailable: boolean
  cliUsesStableSessionId: boolean
}

// Local application of the registry-domain events. Each is main's accepted
// value for one user-editable fact, so a window that lost a last-write-wins
// race converges here rather than holding its own.
type WorkspaceRenamedApply = {
  workspaceId: WorkspaceId
  name: string
  titleLocked?: boolean
}

type WorkspaceLayoutUpdatedApply = {
  workspaceId: WorkspaceId
  layoutModel: Workspace['layoutModel']
}

type WorkspaceFieldsUpdatedApply = {
  workspaceId: WorkspaceId
  patch: WorkspaceFieldsPatch
}

type WorkspaceAgentUpdatedApply = {
  workspaceId: WorkspaceId
  agentId: AgentId
  /** `null` removes the agent from the workspace. */
  patch: Partial<AgentState> | null
  configEditedAt: number
}

type WorkspaceRemovedApply = {
  workspaceId: WorkspaceId
}

export type AgentTerminalLaunchStateApply = {
  workspaceId: WorkspaceId
  agentId: AgentId
  cliSessionId?: string | null
  cliStartRequested?: boolean
  cliHasLaunched?: boolean
  cliOnboardingPromptSent?: boolean
  cliResumeAvailable?: boolean
}

export type WorkspaceSyncDiagnostic = {
  phase: 'dispatch' | 'snapshot' | 'listener' | 'replay'
  reason: string
  message: string
}

export type WorkspaceSyncClientDependencies = {
  getApi: () => WorkspaceSyncClientApi | null
  getWindowId: () => WorkspaceWindowId
  applyActiveChanged: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMoved: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosed: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacement: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreated: (apply: WorkspaceCreatedApply) => void
  applyAgentTerminalSession: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) => void
  applyWorkspaceRenamed: (apply: WorkspaceRenamedApply) => void
  applyWorkspaceLayoutUpdated: (apply: WorkspaceLayoutUpdatedApply) => void
  applyWorkspaceFieldsUpdated: (apply: WorkspaceFieldsUpdatedApply) => void
  applyWorkspaceAgentUpdated: (apply: WorkspaceAgentUpdatedApply) => void
  applyWorkspaceRemoved: (apply: WorkspaceRemovedApply) => void
  /**
   * Adopt main's full registry wholesale. Used to seed the mirror at start and
   * to recover from a sequence gap the bounded replay log can no longer bridge —
   * the resync `applyWorkspaceSyncSnapshot` exists for.
   */
  applyRegistrySnapshot: (snapshot: WorkspaceSyncSnapshot) => void
  logDiagnostic?: (diagnostic: WorkspaceSyncDiagnostic) => void
  /** How long a gesture on a chat's rest waits for main's answer; `LIFECYCLE_ANSWER_MS` when absent. */
  lifecycleAnswerMs?: number
  /**
   * This window's own record of a workspace, as it stands now: a new chat
   * whose create is sent again goes as the window holds it, with what was
   * done to it since. Absent, it goes as it was first proposed.
   */
  currentWorkspace?: (workspaceId: WorkspaceId) => Workspace | null
  /**
   * Where a new chat main never took is told: refused, or unanswered however
   * often it was sent. The window shows it; a chat is never dropped unseen.
   */
  reportUnsavedWorkspace?: (workspace: Workspace, message: string) => void
  /**
   * Where the creates main has not answered are kept across a reload of the
   * window, read once at `start`. Absent, they live in memory only.
   */
  unansweredCreates?: { read(): unknown; write(commands: WorkspaceSyncCommand[]): void }
}

/** What became of a new chat's create: main has it on disk, or it never will. */
export type WorkspaceCreateOutcome = { ok: true } | { ok: false; message: string }

export type WorkspaceSyncClient = {
  /** Subscribe to broadcasts and seed the sequence baseline. Returns cleanup. */
  start: () => () => void
  /** Dispatch a user-initiated active workspace selection through main. */
  dispatchSetActiveWorkspace: (windowId: WorkspaceWindowId, workspaceId: WorkspaceId) => Promise<void>
  /** Dispatch an ownership transfer of a workspace to another window. */
  dispatchMoveWorkspaceToWindow: (
    workspaceId: WorkspaceId,
    fromWindowId: WorkspaceWindowId | null,
    toWindowId: WorkspaceWindowId,
    makeActive: boolean,
  ) => Promise<void>
  /** Dispatch a detached-window close with its fallback window. */
  dispatchCloseWorkspaceWindow: (windowId: WorkspaceWindowId, fallbackWindowId: WorkspaceWindowId) => Promise<void>
  /** Dispatch a (already debounced) window placement update. */
  dispatchUpdatePlacement: (placement: WindowPlacement & { windowId: WorkspaceWindowId }) => Promise<void>
  /** Dispatch a newly created workspace's window assignment. */
  dispatchCreateWorkspace: (
    workspace: Workspace,
    windowId: WorkspaceWindowId,
    folderPath: string | null,
    /** `activate: false`: it joins the window without coming to the front. */
    options?: { activate?: false },
  ) => Promise<void>
  /** Dispatch a verified terminal session assignment for an agent. */
  dispatchAssignTerminalSession: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    sessionId: string,
    cli: AgentCli,
  ) => Promise<void>
  /** Dispatch verified terminal launch-state changes for an agent. */
  dispatchUpdateTerminalLaunchState: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    update: Omit<AgentTerminalLaunchStateApply, 'workspaceId' | 'agentId'>,
  ) => Promise<void>
  /** Ask main to rename a workspace; stamped at the gesture for last-write-wins. */
  dispatchRenameWorkspace: (workspaceId: WorkspaceId, name: string, titleLocked?: boolean) => Promise<void>
  /** Ask main to store a layout the window just computed (renderer-authored, main-persisted). */
  dispatchUpdateWorkspaceLayout: (workspaceId: WorkspaceId, layoutModel: Workspace['layoutModel']) => Promise<void>
  /** Ask main to change user-editable record fields (folder, memory, archive, highlight). */
  dispatchUpdateWorkspaceFields: (workspaceId: WorkspaceId, patch: WorkspaceFieldsPatch) => Promise<void>
  /** Ask main to change one agent's durable config, or `null` to remove the agent. */
  dispatchUpdateWorkspaceAgent: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    patch: Partial<AgentState> | null,
  ) => Promise<void>
  /** Ask main to remove a workspace and tombstone its id. */
  dispatchRemoveWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Settles once main has this window's new workspace on disk (at once for
   * one it already had), or refused it for good. Nothing of a new chat is
   * started before: a crash then never leaves a conversation no chat lists.
   */
  whenCreated: (workspaceId: WorkspaceId) => Promise<WorkspaceCreateOutcome>
  /**
   * Ask main to settle, un-settle, snooze or wake a chat on this window's
   * reading of it. Never throws: a window with no main to ask is answered
   * `unavailable`, and one whose main could not be reached `unreachable`.
   */
  dispatchLifecycleIntent: (request: WorkspaceLifecycleRequest) => Promise<WorkspaceLifecycleResult>
  /** Stop listeners and reset sequence/diagnostic state (used by tests). */
  reset: () => void
}

/** How long a gesture on a chat's rest waits for main's answer before it is asked again. */
const LIFECYCLE_ANSWER_MS = 4_000

// A change main may not have, sent again until it answers. Main answers a
// change only once it is on disk (studio-workspace-sync.ts), so one with no
// answer is one a stop may have taken. Only changes that cannot land twice go
// again: a new workspace, which main refuses by its id once it has it, and
// the stamped edits, which main refuses once a newer one (or the same) is
// applied. Window arrangement (the active chat, placement, moves) is not:
// replayed late it would undo what the person did since.
const RESENT_CHANGES: ReadonlySet<WorkspaceSyncCommand['type']> = new Set([
  'workspace.created',
  'workspace.rename',
  'workspace.update_layout',
  'workspace.update_fields',
  'workspace.update_agent',
  'workspace.remove',
])

/** How many times a change with no answer goes before the window gives it up and says so. */
const MAX_UNANSWERED_SENDS = 5

type Unanswered = { command: WorkspaceSyncCommand; sends: number }

function commandWorkspaceId(command: WorkspaceSyncCommand): WorkspaceId | null {
  if (command.type === 'workspace.created') return command.payload.workspace.id
  const payload = command.payload as { workspaceId?: unknown }
  return typeof payload.workspaceId === 'string' ? payload.workspaceId : null
}

// What a call ends with when its answer, not Studio's no, was lost: the
// connection went (`disconnected`, `closed`, `timeout`), or Studio restarted
// under it (`unknown_outcome`). Any other coded error is Studio's answer.
const LOST_ANSWER_CODES: ReadonlySet<string> = new Set([
  'unknown_outcome',
  'disconnected',
  'closed',
  'timeout',
  'hello_timeout',
  'offline',
  'cancelled',
])

function answerWasLost(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code !== 'string' || LOST_ANSWER_CODES.has(code)
}

/** A refusal that says the change is there after all: a create main already has. */
function landedBefore(command: WorkspaceSyncCommand, reason: string): boolean {
  return command.type === 'workspace.created' && reason === 'workspace_already_exists'
}

function storedCreates(value: unknown): Array<Extract<WorkspaceSyncCommand, { type: 'workspace.created' }>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Extract<WorkspaceSyncCommand, { type: 'workspace.created' }> =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'workspace.created' &&
      typeof (entry as { payload?: { workspace?: { id?: unknown } } }).payload?.workspace?.id === 'string',
  )
}

function withinMs<T>(answer: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms)
    answer.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Whether a chat's rest as main has it is what the gesture asked for. */
function intentStands(request: WorkspaceLifecycleRequest, rest: WorkspaceLifecycleSnapshot): boolean {
  switch (request.intent.kind) {
    case 'settle':
      return rest.settledAt !== null && rest.settledOverride === 'settled'
    case 'unsettle':
      return rest.settledAt === null
    case 'snooze':
      return rest.snoozedUntil === request.intent.until
    case 'wake':
      return rest.snoozedUntil === null
  }
}

export function createWorkspaceSyncClient(deps: WorkspaceSyncClientDependencies): WorkspaceSyncClient {
  let lastAppliedSequence = 0
  let unsubscribe: (() => void) | null = null
  let started = false
  let eventQueue: Promise<void> = Promise.resolve()
  const reportedDiagnostics = new Set<string>()
  // The changes main has not answered, oldest first (RESENT_CHANGES), and who
  // waits on each new workspace's.
  let unanswered: Unanswered[] = []
  const createWaiters = new Map<WorkspaceId, Array<(outcome: WorkspaceCreateOutcome) => void>>()

  const saveUnansweredCreates = (): void => {
    try {
      deps.unansweredCreates?.write(
        unanswered.filter((entry) => entry.command.type === 'workspace.created').map((entry) => entry.command),
      )
    } catch {
      // Kept in memory: only a reload before main answers loses it.
    }
  }
  const track = (command: WorkspaceSyncCommand): Unanswered | null => {
    if (!RESENT_CHANGES.has(command.type)) return null
    const entry: Unanswered = { command, sends: 1 }
    unanswered.push(entry)
    if (command.type === 'workspace.created') saveUnansweredCreates()
    return entry
  }
  // Answered for good: taken (or found already there), or refused. A new
  // workspace refused is told to the person, unless it went with them.
  const settle = (entry: Unanswered, outcome: WorkspaceCreateOutcome, options: { quiet?: boolean } = {}): void => {
    if (!unanswered.includes(entry)) return
    unanswered = unanswered.filter((candidate) => candidate !== entry)
    if (entry.command.type !== 'workspace.created') return
    saveUnansweredCreates()
    const workspace = entry.command.payload.workspace
    const waiters = createWaiters.get(workspace.id) ?? []
    createWaiters.delete(workspace.id)
    for (const waiter of waiters) waiter(outcome)
    if (!outcome.ok && !options.quiet) deps.reportUnsavedWorkspace?.(workspace, outcome.message)
  }
  // Sent and unanswered once more: given up past the limit, else sent again
  // once the connection is back (a request made meanwhile waits for it).
  const unansweredAgain = (entry: Unanswered, error: unknown): void => {
    if (!unanswered.includes(entry)) return
    if (!answerWasLost(error)) {
      settle(entry, { ok: false, message: error instanceof Error ? error.message : String(error) })
      return
    }
    entry.sends += 1
    if (entry.sends > MAX_UNANSWERED_SENDS)
      settle(entry, {
        ok: false,
        message: `Studio did not answer: ${error instanceof Error ? error.message : 'unknown error'}.`,
      })
  }
  // A new workspace goes as this window holds it now, with what was done to
  // it since it was first proposed.
  const resendable = (command: WorkspaceSyncCommand): WorkspaceSyncCommand => {
    if (command.type !== 'workspace.created') return command
    const current = deps.currentWorkspace?.(command.payload.workspace.id)
    return current ? { ...command, payload: { ...command.payload, workspace: current } } : command
  }
  // Every unanswered change, again, in the order it was made; stopped by one
  // that goes unanswered again, which the next connection takes up. Its
  // answer's event is not applied: the registry is read whole right after.
  const resendUnanswered = async (api: WorkspaceSyncClientApi): Promise<void> => {
    for (const entry of [...unanswered]) {
      if (!unanswered.includes(entry)) continue
      let result: WorkspaceSyncCommandResult
      try {
        result = await api.workspaceSyncDispatch(resendable(entry.command))
      } catch (error) {
        unansweredAgain(entry, error)
        return
      }
      if (result.ok || landedBefore(entry.command, result.reason)) settle(entry, { ok: true })
      else settle(entry, { ok: false, message: result.message })
    }
  }

  const log = (diagnostic: WorkspaceSyncDiagnostic): void => {
    // Dedup by phase+reason so an unseeded main service (which rejects every
    // selection during incremental migration) cannot spam the console on each
    // workspace switch while still surfacing the condition once.
    const key = `${diagnostic.phase}:${diagnostic.reason}`
    if (reportedDiagnostics.has(key)) return
    reportedDiagnostics.add(key)
    if (deps.logDiagnostic) {
      deps.logDiagnostic(diagnostic)
      return
    }
    console.warn('[workspaceSync] ' + diagnostic.message, {
      phase: diagnostic.phase,
      reason: diagnostic.reason,
    })
  }

  const applyContiguousEvent = (event: WorkspaceSyncEvent): boolean => {
    if (!Number.isFinite(event.sequence) || event.sequence !== lastAppliedSequence + 1) return false
    const createdAt = Number.isFinite(event.createdAt) ? event.createdAt : Date.now()
    const currentWindowId = deps.getWindowId()
    switch (event.type) {
      case 'workspace_window.active_changed':
        deps.applyActiveChanged({
          windowId: event.payload.windowId,
          workspaceId: event.payload.workspaceId,
          createdAt,
          isCurrentWindow: event.payload.windowId === currentWindowId,
        })
        break
      case 'workspace.moved_to_window':
        deps.applyWorkspaceMoved({
          workspaceId: event.payload.workspaceId,
          fromWindowId: event.payload.fromWindowId,
          toWindowId: event.payload.toWindowId,
          makeActive: event.payload.makeActive,
          createdAt,
          isCurrentWindowTarget: event.payload.toWindowId === currentWindowId,
        })
        break
      case 'workspace_window.placement_updated':
        deps.applyWorkspacePlacement({
          windowId: event.payload.windowId,
          bounds: event.payload.bounds,
          isMaximized: event.payload.isMaximized,
          displayId: event.payload.displayId,
          createdAt,
        })
        break
      case 'workspace_window.closed':
        deps.applyWorkspaceClosed({
          windowId: event.payload.windowId,
          fallbackWindowId: event.payload.fallbackWindowId,
          movedWorkspaceIds: event.payload.movedWorkspaceIds,
          createdAt,
        })
        break
      case 'workspace.created':
        deps.applyWorkspaceCreated({
          workspace: event.payload.workspace,
          windowId: event.payload.windowId,
          folderPath: event.payload.insert.folderPath,
          createdAt,
          isCurrentWindowTarget: event.payload.windowId === currentWindowId,
          activate: event.payload.activate !== false,
        })
        break
      case 'agent_terminal.session_assigned':
        deps.applyAgentTerminalSession(event.payload)
        break
      case 'agent_terminal.launch_state_updated':
        deps.applyAgentTerminalLaunchState(event.payload)
        break
      case 'workspace.renamed':
        deps.applyWorkspaceRenamed({
          workspaceId: event.payload.workspaceId,
          name: event.payload.name,
          ...(event.payload.titleLocked !== undefined ? { titleLocked: event.payload.titleLocked } : {}),
        })
        break
      case 'workspace.layout_updated':
        deps.applyWorkspaceLayoutUpdated({
          workspaceId: event.payload.workspaceId,
          layoutModel: event.payload.layoutModel,
        })
        break
      case 'workspace.fields_updated':
        deps.applyWorkspaceFieldsUpdated({
          workspaceId: event.payload.workspaceId,
          patch: event.payload.patch,
        })
        break
      case 'workspace.agents_updated':
        deps.applyWorkspaceAgentUpdated({
          workspaceId: event.payload.workspaceId,
          agentId: event.payload.agentId,
          patch: event.payload.patch,
          configEditedAt: event.payload.configEditedAt,
        })
        break
      case 'workspace.removed':
        deps.applyWorkspaceRemoved({ workspaceId: event.payload.workspaceId })
        break
    }
    lastAppliedSequence = event.sequence
    return true
  }

  const recoverSequenceGap = async (api: WorkspaceSyncClientApi, event: WorkspaceSyncEvent): Promise<void> => {
    const previousSequence = lastAppliedSequence
    let replayed: WorkspaceSyncEvent[]
    try {
      replayed = await api.workspaceSyncGetEventsAfter(lastAppliedSequence)
    } catch {
      log({
        phase: 'replay',
        reason: 'replay_failed',
        message: 'Failed to replay missed workspace sync events after a sequence gap.',
      })
      await recoverSnapshotBaseline(api)
      return
    }

    const orderedReplay = replayed
      .filter((candidate) => Number.isFinite(candidate.sequence) && candidate.sequence > lastAppliedSequence)
      .sort((a, b) => a.sequence - b.sequence)
    for (const candidate of orderedReplay) {
      if (candidate.sequence <= lastAppliedSequence) continue
      if (candidate.sequence !== lastAppliedSequence + 1) break
      applyContiguousEvent(candidate)
    }

    if (lastAppliedSequence >= event.sequence) return
    if (event.sequence === lastAppliedSequence + 1) {
      applyContiguousEvent(event)
      return
    }

    log({
      phase: 'replay',
      reason: 'incomplete_replay',
      message: `Workspace sync replay after sequence ${previousSequence} did not include a contiguous path to event ${event.sequence}.`,
    })
    await recoverSnapshotBaseline(api)
  }

  // A gap the bounded replay log can no longer bridge is recovered by taking
  // main's whole registry. Before workspace creation moved to main this only advanced the sequence
  // baseline — the registry lived in localStorage and importing main's state
  // would have overwritten the authority with a mirror. It is the other way
  // round now: main IS the authority, so the snapshot is adopted.
  const recoverSnapshotBaseline = async (api: WorkspaceSyncClientApi): Promise<void> => {
    try {
      const snapshot = await api.workspaceSyncGetSnapshot()
      if (!Number.isFinite(snapshot?.sequence)) return
      // Adopt only a snapshot at least as new as what is already applied. The
      // `await` above is a real window: a broadcast can land and advance the
      // baseline while the fetch is in flight, and adopting the older snapshot
      // afterwards would silently undo the event that beat it.
      if (snapshot.sequence < lastAppliedSequence) return
      deps.applyRegistrySnapshot(snapshot)
      lastAppliedSequence = Math.max(lastAppliedSequence, snapshot.sequence)
    } catch {
      log({
        phase: 'snapshot',
        reason: 'snapshot_failed',
        message: 'Failed to read the workspace sync snapshot after replay recovery.',
      })
    }
  }

  const processEvent = async (event: WorkspaceSyncEvent): Promise<void> => {
    if (!Number.isFinite(event.sequence) || event.sequence <= lastAppliedSequence) return
    if (event.sequence === lastAppliedSequence + 1) {
      applyContiguousEvent(event)
      return
    }
    const api = deps.getApi()
    if (!api) {
      log({
        phase: 'replay',
        reason: 'api_unavailable',
        message: 'Workspace sync API is unavailable; skipped noncontiguous workspace sync event.',
      })
      return
    }
    await recoverSequenceGap(api, event)
  }

  // The window's connection opened again. Its Studio may have restarted
  // (out of process), and a new run numbers its changes from the start: every
  // event it sends would be at or below what this window applied, and passed
  // over. So main's registry is read again and adopted whatever its sequence,
  // and the baseline is its sequence; queued with the events, so one that
  // arrives meanwhile is weighed against the new baseline.
  //
  // What this window changed and heard no answer to goes again first, so the
  // registry read after it has it: a new chat stays on screen through a
  // restart of its Studio instead of leaving with the registry read and
  // coming back.
  const resync = (): Promise<void> => {
    eventQueue = eventQueue
      .then(async () => {
        const api = deps.getApi()
        if (!api) return
        await resendUnanswered(api)
        const snapshot = await api.workspaceSyncGetSnapshot()
        if (!Number.isFinite(snapshot?.sequence)) return
        deps.applyRegistrySnapshot(snapshot)
        lastAppliedSequence = snapshot.sequence
      })
      .catch(() => {
        log({
          phase: 'snapshot',
          reason: 'snapshot_failed',
          message: 'Failed to read the workspace sync snapshot after a reconnect.',
        })
      })
    return eventQueue
  }

  const enqueueEvent = (event: WorkspaceSyncEvent): Promise<void> => {
    eventQueue = eventQueue
      .then(() => processEvent(event))
      .catch(() => {
        log({ phase: 'listener', reason: 'event_apply_failed', message: 'Workspace sync event application failed.' })
      })
    return eventQueue
  }

  const start = (): (() => void) => {
    if (started) return () => stop()
    started = true
    const api = deps.getApi()
    if (!api) {
      log({
        phase: 'listener',
        reason: 'api_unavailable',
        message: 'Workspace sync API is unavailable; multi-window selection events are disabled.',
      })
      return () => stop()
    }

    try {
      unsubscribe = api.onWorkspaceSyncEvent(
        (event) => {
          void enqueueEvent(event)
        },
        () => void resync(),
      )
    } catch {
      log({ phase: 'listener', reason: 'subscribe_failed', message: 'Failed to subscribe to workspace sync events.' })
      unsubscribe = null
    }

    // New chats a reload cut off before main answered for them go again, and
    // the registry is read after them.
    let saved: unknown = []
    try {
      saved = deps.unansweredCreates?.read()
    } catch {
      // Unreadable: nothing to send again.
    }
    const stored = storedCreates(saved)
    for (const command of stored)
      if (!unanswered.some((entry) => commandWorkspaceId(entry.command) === commandWorkspaceId(command)))
        unanswered.push({ command, sends: 1 })
    if (stored.length > 0) {
      void resync()
      return () => stop()
    }

    // Seed the mirror from main's registry and take its sequence as the
    // baseline, so events at or below it are treated as already applied. The
    // store's own hydration handshake decides whether this window still has a
    // legacy registry to OFFER main first; by the time this resolves, main's
    // answer is authoritative either way.
    void api
      .workspaceSyncGetSnapshot()
      .then((snapshot) => {
        if (!Number.isFinite(snapshot?.sequence)) return
        // Same ordering guard as the gap recovery above: a broadcast may have
        // already applied while this fetch was in flight.
        if (snapshot.sequence < lastAppliedSequence) return
        deps.applyRegistrySnapshot(snapshot)
        lastAppliedSequence = Math.max(lastAppliedSequence, snapshot.sequence)
      })
      .catch(() => {
        log({ phase: 'snapshot', reason: 'snapshot_failed', message: 'Failed to read the workspace sync snapshot.' })
      })

    return () => stop()
  }

  const stop = (): void => {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        // Listener removal is best-effort.
      }
      unsubscribe = null
    }
    started = false
  }

  // Every user-initiated command flows through here. The local store already
  // applied the change optimistically, so a rejection is a logged no-op and an
  // acceptance only re-applies the accepted event idempotently (advancing the
  // sequence baseline). Failures are never thrown.
  const dispatchCommand = async (command: WorkspaceSyncCommand): Promise<void> => {
    const api = deps.getApi()
    if (!api) {
      log({
        phase: 'dispatch',
        reason: 'api_unavailable',
        message: `Workspace sync API is unavailable; ${command.type} stays local-only.`,
      })
      return
    }
    const entry = track(command)
    let result: WorkspaceSyncCommandResult
    try {
      result = await api.workspaceSyncDispatch(command)
    } catch (error) {
      log({
        phase: 'dispatch',
        reason: 'dispatch_threw',
        message: `Workspace sync dispatch threw: ${error instanceof Error ? error.message : 'unknown error'}.`,
      })
      // Its outcome is unknown (the connection went with it, or Studio
      // restarted): it goes again, before the registry is read once more.
      if (entry && unanswered.includes(entry)) {
        unansweredAgain(entry, error)
        if (unanswered.includes(entry)) void resync()
      }
      return
    }
    if (!result.ok) {
      if (entry && landedBefore(command, result.reason)) {
        settle(entry, { ok: true })
        return
      }
      if (entry) settle(entry, { ok: false, message: result.message })
      log({
        phase: 'dispatch',
        reason: result.reason,
        message: `Workspace sync rejected ${command.type} (${result.reason}): ${result.message}`,
      })
      return
    }
    if (entry) settle(entry, { ok: true })
    await enqueueEvent(result.event)
  }

  const dispatchSetActiveWorkspace = (windowId: WorkspaceWindowId, workspaceId: WorkspaceId): Promise<void> =>
    dispatchCommand({ type: 'workspace_window.set_active', payload: { windowId, workspaceId } })

  const dispatchMoveWorkspaceToWindow = (
    workspaceId: WorkspaceId,
    fromWindowId: WorkspaceWindowId | null,
    toWindowId: WorkspaceWindowId,
    makeActive: boolean,
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.move_to_window',
      payload: { workspaceId, fromWindowId, toWindowId, makeActive },
    })

  const dispatchCloseWorkspaceWindow = (
    windowId: WorkspaceWindowId,
    fallbackWindowId: WorkspaceWindowId,
  ): Promise<void> => dispatchCommand({ type: 'workspace_window.close', payload: { windowId, fallbackWindowId } })

  const dispatchUpdatePlacement = (placement: WindowPlacement & { windowId: WorkspaceWindowId }): Promise<void> =>
    dispatchCommand({ type: 'workspace_window.update_placement', payload: placement })

  const dispatchCreateWorkspace = (
    workspace: Workspace,
    windowId: WorkspaceWindowId,
    folderPath: string | null,
    options: { activate?: false } = {},
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.created',
      payload: {
        workspace,
        windowId,
        insert: { kind: 'folder_head', folderPath },
        ...(options.activate === false ? { activate: false as const } : {}),
      },
    })

  const dispatchAssignTerminalSession = (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    sessionId: string,
    cli: AgentCli,
  ): Promise<void> =>
    dispatchCommand({
      type: 'agent_terminal.assign_session',
      payload: { workspaceId, agentId, sessionId, cli },
    })

  const dispatchUpdateTerminalLaunchState = (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    update: Omit<AgentTerminalLaunchStateApply, 'workspaceId' | 'agentId'>,
  ): Promise<void> =>
    dispatchCommand({
      type: 'agent_terminal.update_launch_state',
      payload: { workspaceId, agentId, ...update },
    })

  // `editedAt` is stamped HERE, at the user gesture, not on arrival in main:
  // a stamp assigned on arrival would make last-write-wins ordering depend on
  // IPC latency, which is the bug the rule exists to prevent.
  const dispatchRenameWorkspace = (workspaceId: WorkspaceId, name: string, titleLocked?: boolean): Promise<void> =>
    dispatchCommand({
      type: 'workspace.rename',
      payload: { workspaceId, name, ...(titleLocked !== undefined ? { titleLocked } : {}), editedAt: Date.now() },
    })

  const dispatchUpdateWorkspaceLayout = (
    workspaceId: WorkspaceId,
    layoutModel: Workspace['layoutModel'],
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.update_layout',
      payload: { workspaceId, layoutModel, editedAt: Date.now() },
    })

  const dispatchUpdateWorkspaceFields = (workspaceId: WorkspaceId, patch: WorkspaceFieldsPatch): Promise<void> =>
    dispatchCommand({
      type: 'workspace.update_fields',
      payload: { workspaceId, patch, editedAt: Date.now() },
    })

  const dispatchUpdateWorkspaceAgent = (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    patch: Partial<AgentState> | null,
  ): Promise<void> =>
    dispatchCommand({
      type: 'workspace.update_agent',
      payload: {
        workspaceId,
        agentId,
        patch: patch === null ? null : agentPatchForWire(patch),
        configEditedAt: Date.now(),
      },
    })

  // A workspace removed takes its unanswered changes with it: a reload must
  // not bring back a chat the person closed.
  const dispatchRemoveWorkspace = (workspaceId: WorkspaceId): Promise<void> => {
    for (const entry of unanswered.filter((candidate) => commandWorkspaceId(candidate.command) === workspaceId))
      settle(entry, { ok: false, message: 'The chat was removed.' }, { quiet: true })
    return dispatchCommand({ type: 'workspace.remove', payload: { workspaceId } })
  }

  const whenCreated = (workspaceId: WorkspaceId): Promise<WorkspaceCreateOutcome> => {
    const waiting = unanswered.some(
      (entry) => entry.command.type === 'workspace.created' && entry.command.payload.workspace.id === workspaceId,
    )
    if (!waiting) return Promise.resolve({ ok: true })
    return new Promise((resolve) => {
      createWaiters.set(workspaceId, [...(createWaiters.get(workspaceId) ?? []), resolve])
    })
  }

  // A row-menu gesture on a chat's rest. The store has applied it already, as
  // it does every hand edit; main decides it on the reading it was made on,
  // and a refusal comes back with the chat as main has it, for the store to
  // put the row back. The accepted change reaches every window, this one
  // included, as a sync event.
  //
  // A call that throws reached nobody (out of process, the server may be
  // restarting under the window), and one with no answer within
  // `LIFECYCLE_ANSWER_MS` is taken as one that did: it is asked once more, and
  // then answered `unreachable`, which is a no, never `unavailable`, which is
  // a window with no main to ask at all. Without the limit, a call that never
  // answers would hold every later gesture on the chat behind it.
  //
  // The second ask carries the first's reading, so if the first did land and
  // only its answer was lost, main calls the second stale. A stale answer
  // whose chat already stands as the gesture asked is that lost yes.
  const dispatchLifecycleIntent = async (request: WorkspaceLifecycleRequest): Promise<WorkspaceLifecycleResult> => {
    const api = deps.getApi()
    if (!api?.workspaceLifecycle) {
      log({
        phase: 'dispatch',
        reason: 'api_unavailable',
        message: `Workspace sync API is unavailable; a ${request.intent.kind} stays local-only.`,
      })
      return { ok: false, code: 'unavailable', message: 'This window has no main process to ask.' }
    }
    const answerMs = deps.lifecycleAnswerMs ?? LIFECYCLE_ANSWER_MS
    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await withinMs(api.workspaceLifecycle(request), answerMs)
        if (!result.ok && attempt > 0 && result.code === 'stale' && result.current)
          if (intentStands(request, result.current))
            return { ok: true, workspaceId: request.workspaceId, committed: result.current }
        if (!result.ok)
          log({
            phase: 'dispatch',
            reason: result.code,
            message: `Main refused a ${request.intent.kind} (${result.code}): ${result.message}`,
          })
        return result
      } catch (error) {
        lastError = error
      }
    }
    log({
      phase: 'dispatch',
      reason: 'dispatch_threw',
      message: `A ${request.intent.kind} got no answer: ${lastError instanceof Error ? lastError.message : 'unknown error'}.`,
    })
    return { ok: false, code: 'unreachable', message: 'Studio could not be reached. Try again in a moment.' }
  }

  const reset = (): void => {
    stop()
    lastAppliedSequence = 0
    eventQueue = Promise.resolve()
    reportedDiagnostics.clear()
    unanswered = []
    createWaiters.clear()
  }

  return {
    start,
    dispatchSetActiveWorkspace,
    dispatchMoveWorkspaceToWindow,
    dispatchCloseWorkspaceWindow,
    dispatchUpdatePlacement,
    dispatchCreateWorkspace,
    dispatchAssignTerminalSession,
    dispatchUpdateTerminalLaunchState,
    dispatchRenameWorkspace,
    dispatchUpdateWorkspaceLayout,
    dispatchUpdateWorkspaceFields,
    dispatchUpdateWorkspaceAgent,
    dispatchRemoveWorkspace,
    whenCreated,
    dispatchLifecycleIntent,
    reset,
  }
}

// The registry over the window's own connection to its Studio
// (`studio/workspaceSync.ts`); none where the page reaches no Studio.
function defaultGetApi(): WorkspaceSyncClientApi | null {
  if (typeof window === 'undefined') return null
  return workspaceSyncReachable('workspaceSyncDispatch') ? workspaceSyncApi : null
}

function defaultGetWindowId(): WorkspaceWindowId {
  if (typeof window === 'undefined') return PRIMARY_WORKSPACE_WINDOW_ID
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || PRIMARY_WORKSPACE_WINDOW_ID
  } catch {
    return PRIMARY_WORKSPACE_WINDOW_ID
  }
}

// The apply callbacks are injected by workspaceStore.ts after the store is
// created, avoiding an import cycle (store → slice → client → store). Each
// handler runs under the store's persist-suppression so an imported event never
// re-emits a command or echoes back through the storage rollback path.
export type WorkspaceSyncEventHandlers = {
  applyActiveChanged: (apply: WorkspaceActiveChangedApply) => void
  applyWorkspaceMoved: (apply: WorkspaceMovedApply) => void
  applyWorkspaceClosed: (apply: WorkspaceClosedApply) => void
  applyWorkspacePlacement: (apply: WorkspacePlacementApply) => void
  applyWorkspaceCreated: (apply: WorkspaceCreatedApply) => void
  applyAgentTerminalSession: (apply: AgentTerminalSessionApply) => void
  applyAgentTerminalLaunchState: (apply: AgentTerminalLaunchStateApply) => void
  applyWorkspaceRenamed: (apply: WorkspaceRenamedApply) => void
  applyWorkspaceLayoutUpdated: (apply: WorkspaceLayoutUpdatedApply) => void
  applyWorkspaceFieldsUpdated: (apply: WorkspaceFieldsUpdatedApply) => void
  applyWorkspaceAgentUpdated: (apply: WorkspaceAgentUpdatedApply) => void
  applyWorkspaceRemoved: (apply: WorkspaceRemovedApply) => void
  applyRegistrySnapshot: (snapshot: WorkspaceSyncSnapshot) => void
  currentWorkspace?: (workspaceId: WorkspaceId) => Workspace | null
  reportUnsavedWorkspace?: (workspace: Workspace, message: string) => void
}

/** Where this window keeps the new chats main has not answered for, across a reload. */
function unansweredCreatesStorage(): WorkspaceSyncClientDependencies['unansweredCreates'] {
  if (typeof window === 'undefined') return undefined
  const key = () => `sprintengine-unanswered-workspace-creates:${defaultGetWindowId()}`
  return {
    read: () => {
      const raw = window.localStorage.getItem(key())
      return raw ? (JSON.parse(raw) as unknown) : []
    },
    write: (commands) => {
      if (commands.length === 0) window.localStorage.removeItem(key())
      else window.localStorage.setItem(key(), JSON.stringify(commands))
    },
  }
}

let configuredHandlers: WorkspaceSyncEventHandlers | null = null

export function configureWorkspaceSyncClient(handlers: WorkspaceSyncEventHandlers): void {
  configuredHandlers = handlers
}

export const workspaceSyncClient = createWorkspaceSyncClient({
  getApi: defaultGetApi,
  getWindowId: defaultGetWindowId,
  applyActiveChanged: (apply) => configuredHandlers?.applyActiveChanged(apply),
  applyWorkspaceMoved: (apply) => configuredHandlers?.applyWorkspaceMoved(apply),
  applyWorkspaceClosed: (apply) => configuredHandlers?.applyWorkspaceClosed(apply),
  applyWorkspacePlacement: (apply) => configuredHandlers?.applyWorkspacePlacement(apply),
  applyWorkspaceCreated: (apply) => configuredHandlers?.applyWorkspaceCreated(apply),
  applyAgentTerminalSession: (apply) => configuredHandlers?.applyAgentTerminalSession(apply),
  applyAgentTerminalLaunchState: (apply) => configuredHandlers?.applyAgentTerminalLaunchState(apply),
  applyWorkspaceRenamed: (apply) => configuredHandlers?.applyWorkspaceRenamed(apply),
  applyWorkspaceLayoutUpdated: (apply) => configuredHandlers?.applyWorkspaceLayoutUpdated(apply),
  applyWorkspaceFieldsUpdated: (apply) => configuredHandlers?.applyWorkspaceFieldsUpdated(apply),
  applyWorkspaceAgentUpdated: (apply) => configuredHandlers?.applyWorkspaceAgentUpdated(apply),
  applyWorkspaceRemoved: (apply) => configuredHandlers?.applyWorkspaceRemoved(apply),
  applyRegistrySnapshot: (snapshot) => configuredHandlers?.applyRegistrySnapshot(snapshot),
  currentWorkspace: (workspaceId) => configuredHandlers?.currentWorkspace?.(workspaceId) ?? null,
  reportUnsavedWorkspace: (workspace, message) => configuredHandlers?.reportUnsavedWorkspace?.(workspace, message),
  unansweredCreates: unansweredCreatesStorage(),
})
