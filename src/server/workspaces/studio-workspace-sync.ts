import type {
  StudioWorkspaceBackupPayload,
  StudioWorkspaceBackupReadResult,
  StudioWorkspaceBackupWriteResult,
  StudioWorkspaceLifecycleResult,
  StudioWorkspaceRegistryHydrateResult,
  StudioWorkspaceSyncCommandResult,
  StudioWorkspaceSyncEvent,
  StudioWorkspaceSyncSnapshot,
} from '../../../packages/studio-protocol/src/public'
import { createProjectlessChatFolder, ensureProjectlessChatsRoot } from '../../main/projectless-chat-folders'
import { createWorkspaceBackupService } from '../../main/workspace-backup'
import type { WorkspaceRegistryHydratePayload } from '../../main/workspace-registry-service'
import { parseWorkspaceLifecycleRequest } from '../../shared/workspace-lifecycle'
import type { StudioCore } from '../core/studio-core'

// The desktop's own windows' workspace registry as the protocol serves it
// (`workspaceSync.*`, `workspaceRegistry.*`, `workspaceBackup.*`,
// `projectlessChats.*`): the core's registry and its change bus, the rest
// decisions its lifecycle makes on a window's reading, the sweep's inputs only
// a window knows, the window's backup of its own copy, and the folders a chat
// with no project runs in. Who may ask is the router's (an owner's alone);
// what a command says is checked by the registry, as it always was.

export type StudioWorkspaceSync = {
  snapshot(): StudioWorkspaceSyncSnapshot
  eventsAfter(sequence: number): StudioWorkspaceSyncEvent[]
  dispatch(command: Record<string, unknown>, windowId: string): Promise<StudioWorkspaceSyncCommandResult>
  lifecycle(request: Record<string, unknown>): Promise<StudioWorkspaceLifecycleResult>
  setSettledChatsSettings(settings: Record<string, unknown>): void
  setModuleRunStates(states: Record<string, unknown>): void
  needsHydration(): boolean
  hydrate(payload: Record<string, unknown>): StudioWorkspaceRegistryHydrateResult
  backupRead(): Promise<StudioWorkspaceBackupReadResult>
  backupWrite(payload: StudioWorkspaceBackupPayload): Promise<StudioWorkspaceBackupWriteResult>
  projectlessRoot(): Promise<string>
  createProjectlessFolder(prompt: string | null): Promise<string>
  /** Hear each change the registry records, whoever made it. Returns the unsubscriber. */
  onEvent(listener: (event: StudioWorkspaceSyncEvent) => void): () => void
}

type Core = Pick<
  StudioCore,
  | 'workspaceSyncService'
  | 'workspaceRegistry'
  | 'conversationLifecycle'
  | 'settledChatsSettings'
  | 'settlement'
  | 'platform'
  | 'environmentReplicas'
>

export function createStudioWorkspaceSync(core: Core): StudioWorkspaceSync {
  const sync = core.workspaceSyncService
  // A window's own stored copy, written beside the registry it backs up; at
  // most one registry serialization every ten seconds, the newest written
  // when the interval ends.
  const backup = createWorkspaceBackupService({
    resolveUserDataDir: () => core.platform.paths.dataDir(),
    readRegistry: () => core.workspaceRegistry.getState(),
    minRegistryIntervalMs: 10_000,
  })
  const listeners = new Set<(event: StudioWorkspaceSyncEvent) => void>()
  let unsubscribe: (() => void) | null = null
  const asEvent = (event: unknown) => event as StudioWorkspaceSyncEvent
  return {
    snapshot: () => sync.getSnapshot() as unknown as StudioWorkspaceSyncSnapshot,
    eventsAfter: (sequence) => sync.getEventsAfter(sequence).map(asEvent),
    async dispatch(command, windowId) {
      // A change to the record of a chat another environment holds is made
      // there first, and here as that environment then reads
      // (environment-replicas.ts); the window's arrangement is made here.
      const forwarded = await core.environmentReplicas?.dispatch(command)
      if (forwarded) return forwarded
      const result = sync.dispatch({ command, sourceWindowId: windowId })
      // A window's change is recorded without a broadcast of its own (the
      // IPC sent it to every other window); here every follower hears it on
      // `workspaceSync.events`, the window that made it included, which
      // takes it once by its sequence.
      if (result.ok) for (const listener of listeners) listener(asEvent(result.event))
      return result as unknown as StudioWorkspaceSyncCommandResult
    },
    async lifecycle(request) {
      const parsed = parseWorkspaceLifecycleRequest(request)
      if (!parsed) return { ok: false, code: 'invalid_arguments', message: 'That is not a change to a chat’s rest.' }
      const forwarded = await core.environmentReplicas?.lifecycle(request)
      if (forwarded) return forwarded
      return core.conversationLifecycle.fromWindow(parsed) as StudioWorkspaceLifecycleResult
    },
    setSettledChatsSettings: (settings) => core.settledChatsSettings.set(settings),
    setModuleRunStates: (states) => core.settlement.setModuleRunStates(states),
    needsHydration: () => core.workspaceRegistry.needsHydration(),
    hydrate: (payload) => core.workspaceRegistry.hydrate(payload as WorkspaceRegistryHydratePayload),
    backupRead: () => backup.read(),
    backupWrite: (payload) => backup.write(payload),
    projectlessRoot: () => ensureProjectlessChatsRoot(),
    createProjectlessFolder: (prompt) => createProjectlessChatFolder(prompt),
    onEvent(listener) {
      listeners.add(listener)
      // Events minted with no window to skip (a gateway create, the scheduler,
      // a phone) come from the registry's own subscription.
      unsubscribe ??= sync.subscribeEvents((event) => {
        for (const each of listeners) each(asEvent(event))
      })
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribe?.()
          unsubscribe = null
        }
      }
    },
  }
}
