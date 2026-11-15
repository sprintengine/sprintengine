import { randomUUID } from 'node:crypto'

import type {
  StudioWorkspaceLifecycleResult,
  StudioWorkspaceSyncCommandResult,
  StudioWorkspaceSyncEvent,
  StudioWorkspaceSyncSnapshot,
} from '../../../packages/studio-protocol/src/public'
import { STUDIO_WORKSPACE_SYNC_CAPABILITY } from '../../../packages/studio-protocol/src/handshake'
import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { WorkspaceSyncService } from '../../main/workspace-sync-service'
import type { AgentState, Workspace } from '../../renderer/src/types/workspace'
import { environmentRouteOfRecord, type EnvironmentClients } from '../../shared/environment-clients'
import type { WorkspaceFieldsPatch, WorkspaceSyncEvent } from '../../shared/workspace-sync'

// This desktop's copies of the chats another environment holds
// (design-wsl-ssh-direct PR 1d, decision 1; a WSL distribution's, PR 3c). An
// SSH machine's or a distribution's Studio owns its chats' records: their folder, agents, name, marks and rest. This desktop's
// registry keeps a copy of each, stamped `environment`, because its windows
// arrange them (which window, which is active, where in the sidebar), and that
// arrangement is this desktop's alone.
//
// The trust rule: a copy is written here only from what the machine's own
// Studio says, read over this desktop's owner connection to it
// (`environmentClients`), and only to the fields the machine owns. A window's
// change to a copy's record is not made here: it goes to the machine first, and
// is made here only as the machine then reads. A machine that is not connected
// refuses it in words; the copy stays as it was last read. Nothing a window, a
// phone or an agent on this desktop says writes a copy directly, and nothing
// of this desktop's goes to the machine but its own windows' changes.
//
// The window's arrangement is kept here and never sent: the window a copy is
// in, the active chat, window placement, and the chat's pane layout.

/** The fields of a record the environment that holds the chat writes, beside its name and agents. */
const MIRRORED_FIELDS = [
  'folderPath',
  'folderMissing',
  'memory',
  'settledAt',
  'settledOverride',
  'autoSettleEnabled',
  'autoCompactEnabled',
  'snoozedUntil',
  'highlight',
  'worktree',
  'lastTerminalActivityAt',
  'lastUserMessageAt',
  'lastTurnEndedAt',
  'lastVisitedAt',
  'visitRewoundAt',
] as const satisfies readonly (keyof WorkspaceFieldsPatch)[]

/** The rest of a record's fields a copy takes as the machine has them, beside those written below. */
const COPIED_FIELDS = [
  ...MIRRORED_FIELDS,
  'titleLocked',
  'scheduledAgentId',
  'lastActiveAgentId',
] as const satisfies readonly (keyof Workspace)[]

/**
 * An agent's launch fields a window acts on once, with this desktop's own
 * files: New chat's first message and the images and files it reads from this
 * disk to send with it.
 */
const ONE_SHOT_LAUNCH_FIELDS = ['chatStartupPrompt', 'chatStartupImages', 'chatStartupFiles'] as const

const launchKey = (workspaceId: string, agentId: string) => `${workspaceId}\u0000${agentId}`

/** The tab components a copy's layout keeps: a chat's agents, and the picker an empty chat shows. */
const COPIED_TAB_COMPONENTS: ReadonlySet<string> = new Set(['agent', 'new-agent'])

/**
 * A copy's layout, from the machine's: its rows, tab sets and the tabs of its
 * own agents, each with only the agent it shows. No other tab and no other
 * config: a tab's config names what a window here opens (a file, a conflict
 * to resolve, a terminal), and a machine never names that.
 */
function copyLayout(given: unknown, agentIds: ReadonlySet<string>): Workspace['layoutModel'] {
  const layout = isRecord(given) ? given : {}
  const global: Record<string, unknown> = {}
  if (isRecord(layout.global))
    for (const [key, value] of Object.entries(layout.global))
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') global[key] = value
  const root = copyLayoutNode(layout.layout, agentIds)
  return {
    global,
    borders: [],
    layout: root && root.type === 'row' ? root : { type: 'row', children: root ? [root] : [] },
  } as Workspace['layoutModel']
}

function copyLayoutNode(node: unknown, agentIds: ReadonlySet<string>): Record<string, unknown> | null {
  if (!isRecord(node) || typeof node.type !== 'string') return null
  const base: Record<string, unknown> = { type: node.type }
  if (typeof node.id === 'string') base.id = node.id
  if (typeof node.weight === 'number') base.weight = node.weight
  if (node.type === 'tab') {
    if (typeof node.component !== 'string' || !COPIED_TAB_COMPONENTS.has(node.component)) return null
    base.component = node.component
    if (typeof node.name === 'string') base.name = node.name
    if (node.component === 'agent') {
      const agentId = isRecord(node.config) ? node.config.agentId : undefined
      if (typeof agentId !== 'string' || !agentIds.has(agentId)) return null
      base.config = { agentId }
    }
    return base
  }
  if (node.type !== 'row' && node.type !== 'tabset') return null
  if (typeof node.selected === 'number') base.selected = node.selected
  if (node.type === 'tabset' && typeof node.active === 'boolean') base.active = node.active
  const children = Array.isArray(node.children)
    ? node.children.map((child) => copyLayoutNode(child, agentIds)).filter((child) => child !== null)
    : []
  if (node.type === 'tabset' && typeof base.selected === 'number' && (base.selected as number) >= children.length)
    base.selected = Math.max(0, children.length - 1)
  base.children = children
  return base
}

/** The registry changes a window makes to a chat's record; every other command is its arrangement, kept here. */
const RECORD_COMMANDS: ReadonlySet<string> = new Set([
  'workspace.created',
  'workspace.rename',
  'workspace.update_fields',
  'workspace.update_agent',
  'workspace.remove',
  'agent_terminal.assign_session',
  'agent_terminal.update_launch_state',
])

type Sync = Pick<
  WorkspaceSyncService,
  | 'getSnapshot'
  | 'adoptWorkspace'
  | 'renameWorkspace'
  | 'mirrorWorkspaceFields'
  | 'updateWorkspaceAgent'
  | 'removeWorkspace'
  | 'subscribeEvents'
>

export type EnvironmentReplicaDeps = {
  clients: EnvironmentClients
  sync: Sync
  log?(message: string): void
  /** How long a run of the machine's changes is folded into one read (ms). */
  foldMs?: number
}

export type EnvironmentReplicas = {
  /**
   * Keep this desktop's copies of the route's chats as the machine has them,
   * from now until its connection ends: read now, and again after each change
   * it records. Called once the machine holds the records (the hand-over has
   * delivered them), so a copy it no longer has is removed here.
   */
  follow(route: string): Promise<void>
  /** Read the route's records now and bring the copies here in line. */
  refresh(route: string): Promise<void>
  /**
   * A window's registry change. One to a copy's record is the machine's to make
   * and is made there first; null when it is this desktop's own to make.
   */
  dispatch(command: Record<string, unknown>): Promise<StudioWorkspaceSyncCommandResult | null>
  /** A window's Settle, Un-settle, Snooze or Wake: the machine's for a copy; null for this desktop's own chat. */
  lifecycle(request: Record<string, unknown>): Promise<StudioWorkspaceLifecycleResult | null>
  close(): void
}

type Followed = { client: StudioClient; name: string; stop: () => void }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The workspace a record command names, or the one a create makes. */
function commandWorkspace(command: Record<string, unknown>): { id: string; created: Workspace | null } | null {
  const payload = isRecord(command.payload) ? command.payload : null
  if (!payload) return null
  if (command.type === 'workspace.created') {
    const workspace = isRecord(payload.workspace) ? (payload.workspace as unknown as Workspace) : null
    return workspace && typeof workspace.id === 'string' ? { id: workspace.id, created: workspace } : null
  }
  return typeof payload.workspaceId === 'string' ? { id: payload.workspaceId, created: null } : null
}

export function createEnvironmentReplicas(deps: EnvironmentReplicaDeps): EnvironmentReplicas {
  const { sync } = deps
  const foldMs = deps.foldMs ?? 250
  const followed = new Map<string, Followed>()
  // One read and one write at a time per machine: a fold, a window's change and
  // a reconnect never interleave their writes to the same copies.
  const queues = new Map<string, Promise<unknown>>()
  let closed = false
  // The one-shot launch fields a window here set on a copy's agent, by
  // workspace and agent: the only ones its copy carries (`copyAgents`).
  const launchFieldsSent = new Map<string, Record<string, unknown>>()

  const serial = <T>(route: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(route) ?? Promise.resolve()).then(work, work)
    queues.set(
      route,
      run.catch(() => undefined),
    )
    return run
  }

  const recordOf = (id: string): Workspace | null =>
    (sync.getSnapshot().state.workspaces.find((workspace) => workspace.id === id) as Workspace | undefined) ?? null

  async function reach(route: string) {
    const known = followed.get(route)
    if (known && known.client.state !== 'closed') return { ok: true as const, client: known.client, name: known.name }
    return deps.clients.clientFor(route, STUDIO_WORKSPACE_SYNC_CAPABILITY)
  }

  /**
   * The machine's records as this desktop keeps its copies of them: its paths
   * respelled, stamped where they live, and built from the fields the machine
   * owns, named one by one (`copyOf`). Nothing else it sends is taken: not the
   * window's own state of a chat (its editor, file tree, Git panel, panes,
   * backlog and modules), not a pane's config in its layout (a tab names a
   * file on this desktop to open), and not an agent's one-shot launch fields
   * (a New chat's images and files, read from this desktop's disk and sent
   * with its first message) unless a window here set them.
   */
  function copyOf(route: string, name: string, workspace: Workspace): Workspace {
    const machine = parseEnvironmentRoute(route)
    const hostId = machine?.kind === 'wsl' ? (`wsl:${machine.distro}` as const) : null
    const agents = copyAgents(workspace.id, workspace.agents, hostId)
    const own = workspace as unknown as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    for (const field of COPIED_FIELDS) if (own[field] !== undefined) kept[field] = own[field]
    const editedName = (own.fieldEditedAt as { name?: unknown } | undefined)?.name
    return {
      ...(kept as Partial<Workspace>),
      id: workspace.id,
      name: typeof workspace.name === 'string' ? workspace.name : workspace.id,
      mode: workspace.mode,
      folderPath: typeof workspace.folderPath === 'string' ? workspace.folderPath : null,
      templateId: typeof workspace.templateId === 'string' ? workspace.templateId : '',
      createdAt: typeof workspace.createdAt === 'number' ? workspace.createdAt : 0,
      ...(typeof editedName === 'number' ? ({ fieldEditedAt: { name: editedName } } as object) : {}),
      layoutModel: copyLayout(workspace.layoutModel, new Set(Object.keys(agents))),
      agents,
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      memory: isRecord(workspace.memory) ? workspace.memory : { relativeRoot: null },
      editorState: { openFiles: [], activeFilePath: null },
      ...(machine?.kind === 'wsl'
        ? {
            environment: { kind: 'wsl', id: machine.distro, label: name },
            // A WSL chat's terminals are still this PC's, run in the distribution
            // through `wsl.exe` (design-wsl-ssh-direct PR 4), as is the git this
            // desktop runs on its folder: its machine stays its `hostId`.
            hostId: hostId!,
          }
        : { environment: { kind: 'ssh', id: machine?.kind === 'ssh' ? machine.machine : route, label: name } }),
    }
  }

  /**
   * A copy's agents: each runs where the chat lives (a WSL chat's in its
   * distribution, never on this PC; an SSH chat's on that machine), and carries
   * a one-shot launch field only when a window here set it for that agent.
   */
  function copyAgents(workspaceId: string, given: unknown, hostId: `wsl:${string}` | null): Record<string, AgentState> {
    const agents: Record<string, AgentState> = {}
    if (!isRecord(given)) return agents
    for (const [agentId, agent] of Object.entries(given)) {
      if (!isRecord(agent)) continue
      // Written out as absent rather than left out: a copy's agent is updated
      // by merging, and a field left out would keep what it was here.
      const copy: Record<string, unknown> = { ...agent, hostId: hostId ?? undefined }
      const sent = launchFieldsSent.get(launchKey(workspaceId, agentId))
      for (const field of ONE_SHOT_LAUNCH_FIELDS)
        copy[field] = sent && field in sent && same(sent[field], agent[field]) ? sent[field] : undefined
      agents[agentId] = copy as AgentState
    }
    return agents
  }

  /** Remember the one-shot launch fields a window here sets on a copy's agent, for its copy to keep. */
  function rememberLaunchFields(command: Record<string, unknown>): void {
    const payload = isRecord(command.payload) ? command.payload : null
    if (!payload) return
    const remember = (workspaceId: string, agentId: string, fields: Record<string, unknown> | null) => {
      const key = launchKey(workspaceId, agentId)
      const before = launchFieldsSent.get(key) ?? {}
      const after: Record<string, unknown> = { ...before }
      for (const field of ONE_SHOT_LAUNCH_FIELDS) {
        if (fields === null) delete after[field]
        else if (field in fields) {
          if (fields[field] === undefined || fields[field] === null) delete after[field]
          else after[field] = fields[field]
        }
      }
      if (Object.keys(after).length > 0) launchFieldsSent.set(key, after)
      else launchFieldsSent.delete(key)
    }
    if (command.type === 'workspace.update_agent' && typeof payload.workspaceId === 'string') {
      if (typeof payload.agentId === 'string')
        remember(payload.workspaceId, payload.agentId, isRecord(payload.patch) ? payload.patch : null)
      return
    }
    if (command.type === 'workspace.created' && isRecord(payload.workspace)) {
      const created = payload.workspace
      if (typeof created.id !== 'string' || !isRecord(created.agents)) return
      for (const [agentId, agent] of Object.entries(created.agents))
        if (isRecord(agent)) remember(created.id, agentId, agent)
    }
  }

  /** Bring this desktop's copies of the route's chats in line with the machine's records. */
  function reconcile(
    route: string,
    name: string,
    snapshot: StudioWorkspaceSyncSnapshot,
    removeMissing: boolean,
    placing: { id: string; windowId: string; activate: boolean } | null = null,
  ) {
    const theirs = Array.isArray(snapshot.state.workspaces) ? (snapshot.state.workspaces as Workspace[]) : []
    const here = sync.getSnapshot().state
    const primary = here.primaryWorkspaceWindowId
    const seen = new Set<string>()
    for (const workspace of theirs) {
      if (!isRecord(workspace) || typeof workspace.id !== 'string') continue
      seen.add(workspace.id)
      const copy = copyOf(route, name, workspace)
      const local = here.workspaces.find((each) => each.id === workspace.id) as Workspace | undefined
      if (!local) {
        // A chat born there (its own schedule's run, a phone's New chat) joins
        // the primary window here without being brought to the front; one a
        // window here asked for joins that window as it asked.
        const placed = placing?.id === workspace.id && here.workspaceWindows.some((w) => w.id === placing.windowId)
        const adopted = sync.adoptWorkspace(
          copy,
          placed ? placing.windowId : primary,
          copy.folderPath,
          'system',
          placed && placing.activate ? {} : { activate: false },
        )
        if (!adopted.ok) deps.log?.(`Could not keep a copy of ${name}'s chat ${workspace.id}: ${adopted.message}`)
        continue
      }
      // An id this desktop's own chat already has is not overwritten.
      if (environmentRouteOfRecord(local) !== route) continue
      if (local.name !== copy.name || Boolean(local.titleLocked) !== Boolean(copy.titleLocked))
        sync.renameWorkspace(
          local.id,
          copy.name,
          Boolean(copy.titleLocked),
          'system',
          (copy as { fieldEditedAt?: { name?: number } }).fieldEditedAt?.name ?? Date.now(),
        )
      const patch: Record<string, unknown> = {}
      for (const field of MIRRORED_FIELDS) {
        const value = (copy as Record<string, unknown>)[field]
        if (!same((local as Record<string, unknown>)[field], value)) patch[field] = value ?? null
      }
      if (Object.keys(patch).length > 0) sync.mirrorWorkspaceFields(local.id, patch as WorkspaceFieldsPatch, 'system')
      const agents = isRecord(copy.agents) ? copy.agents : {}
      for (const [agentId, agent] of Object.entries(agents))
        if (!same(local.agents?.[agentId], agent))
          sync.updateWorkspaceAgent(local.id, agentId, agent as AgentState, 'system', 0)
      for (const agentId of Object.keys(local.agents ?? {}))
        if (!(agentId in agents)) sync.updateWorkspaceAgent(local.id, agentId, null, 'system', 0)
    }
    if (!removeMissing) return
    for (const local of here.workspaces)
      if (environmentRouteOfRecord(local) === route && !seen.has(local.id)) sync.removeWorkspace(local.id, 'system')
  }

  async function read(route: string, removeMissing: boolean): Promise<void> {
    const reached = await reach(route)
    if (!reached.ok) {
      deps.log?.(`Could not read ${route}'s chats: ${reached.message}`)
      return
    }
    const snapshot = (await reached.client.request('workspaceSync.snapshot', {})) as StudioWorkspaceSyncSnapshot
    reconcile(route, reached.name, snapshot, removeMissing)
  }

  const refresh = (route: string) =>
    serial(route, () =>
      read(route, followed.has(route)).catch((error: unknown) =>
        deps.log?.(`Could not read ${route}'s chats: ${error instanceof Error ? error.message : String(error)}`),
      ),
    )

  async function follow(route: string): Promise<void> {
    if (closed) return
    const known = followed.get(route)
    if (known && known.client.state !== 'closed') return refresh(route)
    known?.stop()
    const reached = await deps.clients.clientFor(route, STUDIO_WORKSPACE_SYNC_CAPABILITY)
    if (!reached.ok) {
      deps.log?.(`Not following ${route}'s chats: ${reached.message}`)
      return
    }
    let fold: ReturnType<typeof setTimeout> | null = null
    const stopFold = () => {
      if (fold) clearTimeout(fold)
      fold = null
    }
    const unsubscribe = reached.client.subscribe(
      'workspaceSync.events',
      {},
      {
        onPayload: () => {
          if (fold) return
          fold = setTimeout(() => {
            fold = null
            void refresh(route)
          }, foldMs)
          ;(fold as { unref?: () => void }).unref?.()
        },
        // The owner connection does not reconnect: the next connect follows
        // again. The copies stay as last read, drawn stale by the window.
        onEnd: () => {
          stopFold()
          if (followed.get(route)?.client === reached.client) followed.delete(route)
        },
      },
    )
    followed.set(route, {
      client: reached.client,
      name: reached.name,
      stop: () => {
        stopFold()
        unsubscribe()
      },
    })
    await refresh(route)
  }

  /** The copy's route a window's command is about, or null when the change is this desktop's own. */
  function routeOfCommand(command: Record<string, unknown>): { route: string; id: string } | null {
    if (typeof command.type !== 'string' || !RECORD_COMMANDS.has(command.type)) return null
    const named = commandWorkspace(command)
    if (!named) return null
    const route = environmentRouteOfRecord(named.created ?? recordOf(named.id))
    return route ? { route, id: named.id } : null
  }

  /** What the machine is sent: its own window, no environment of its own. */
  function forMachine(command: Record<string, unknown>, windowId: string): Record<string, unknown> {
    if (command.type !== 'workspace.created' || !isRecord(command.payload)) return command
    const { environment: _environment, hostId: _hostId, ...workspace } = command.payload.workspace as Workspace
    return { ...command, payload: { ...command.payload, workspace, windowId } }
  }

  const notConnected = (route: string, message?: string) => {
    const machine = parseEnvironmentRoute(route)
    const name = machine?.kind === 'ssh' ? machine.machine : machine?.kind === 'wsl' ? `WSL: ${machine.distro}` : route
    return message ?? `${name} is not connected.`
  }

  async function dispatch(command: Record<string, unknown>): Promise<StudioWorkspaceSyncCommandResult | null> {
    const target = routeOfCommand(command)
    if (!target) return null
    const { route, id } = target
    rememberLaunchFields(command)
    return serial(route, async (): Promise<StudioWorkspaceSyncCommandResult> => {
      const refuse = (reason: string, message: string): StudioWorkspaceSyncCommandResult => ({
        ok: false,
        reason,
        message,
        snapshot: sync.getSnapshot() as unknown as StudioWorkspaceSyncSnapshot,
      })
      const reached = await reach(route)
      if (!reached.ok) return refuse('environment_unreachable', notConnected(route, reached.message))
      try {
        const theirs = (await reached.client.request('workspaceSync.snapshot', {})) as StudioWorkspaceSyncSnapshot
        const windowId = String(theirs.state.primaryWorkspaceWindowId ?? '')
        const answer = (await reached.client.request('workspaceSync.dispatch', {
          commandId: `replica-${randomUUID()}`,
          windowId,
          command: forMachine(command, windowId),
        })) as StudioWorkspaceSyncCommandResult
        if (!answer.ok) return refuse(answer.reason, `${reached.name}: ${answer.message}`)
        // Made there: made here as the machine now reads, and answered with
        // the change this registry recorded for the window to take.
        const made: WorkspaceSyncEvent[] = []
        const stop = sync.subscribeEvents((event) => made.push(event))
        try {
          const after = (await reached.client.request('workspaceSync.snapshot', {})) as StudioWorkspaceSyncSnapshot
          const payload = isRecord(command.payload) ? command.payload : {}
          reconcile(
            route,
            reached.name,
            after,
            followed.has(route),
            command.type === 'workspace.created' && typeof payload.windowId === 'string'
              ? { id, windowId: payload.windowId, activate: payload.activate !== false }
              : null,
          )
        } finally {
          stop()
        }
        const mine = made.filter((event) => eventNames(event, id)).at(-1) ?? made.at(-1)
        return mine
          ? { ok: true, event: mine as unknown as StudioWorkspaceSyncEvent }
          : refuse('unchanged', `${reached.name} already had that.`)
      } catch (error) {
        return refuse(
          'environment_unreachable',
          `${reached.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  }

  async function lifecycle(request: Record<string, unknown>): Promise<StudioWorkspaceLifecycleResult | null> {
    const id = typeof request.workspaceId === 'string' ? request.workspaceId : null
    const route = id ? environmentRouteOfRecord(recordOf(id)) : null
    if (!route) return null
    return serial(route, async (): Promise<StudioWorkspaceLifecycleResult> => {
      const reached = await reach(route)
      if (!reached.ok)
        return { ok: false, code: 'environment_unreachable', message: notConnected(route, reached.message) }
      try {
        const answer = (await reached.client.request('workspaceSync.lifecycle', {
          commandId: `replica-${randomUUID()}`,
          request,
        })) as StudioWorkspaceLifecycleResult
        const after = (await reached.client.request('workspaceSync.snapshot', {})) as StudioWorkspaceSyncSnapshot
        reconcile(route, reached.name, after, followed.has(route))
        return answer
      } catch (error) {
        return {
          ok: false,
          code: 'environment_unreachable',
          message: `${reached.name}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    })
  }

  return {
    follow,
    refresh,
    dispatch,
    lifecycle,
    close() {
      closed = true
      for (const each of followed.values()) each.stop()
      followed.clear()
    },
  }
}

/** Whether a recorded event is about the workspace `id`. */
function eventNames(event: WorkspaceSyncEvent, id: string): boolean {
  const payload = event.payload as { workspaceId?: unknown; workspace?: { id?: unknown } }
  return payload.workspaceId === id || payload.workspace?.id === id
}
