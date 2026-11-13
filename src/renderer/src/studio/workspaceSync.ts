import {
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_WORKSPACE_SYNC_CAPABILITY,
  type StudioCapability,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import { StudioError } from '../../../../packages/client-runtime/src/public'
import type { LifecycleState } from '../../../shared/lifecycle-state'
import type { WorkspaceBackupPayload, WorkspaceBackupReadResult } from '../../../shared/ipc/workspace-backup'
import type { WorkspaceBackupWriteResult } from '../../../shared/ipc/app'
import type { WorkspaceRegistryHydrateResult } from '../../../shared/ipc/terminal'
import type { WorkspaceLifecycleRequest, WorkspaceLifecycleResult } from '../../../shared/workspace-lifecycle'
import type { SettledChatsSettings } from '../../../shared/workspace-settlement'
import type {
  WorkspaceMarkUnreadResult,
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from '../../../shared/workspace-sync'
import { followWindowStudioPush } from './windowStudioPush'
import { windowHasStudio, windowStudioClient } from './windowStudioClient'

// The window's way to the desktop's workspace registry: the Studio protocol's
// `workspaceSync.*` and its `workspaceSync.events` stream, the one-time
// hydration and the window's backup of its own copy, and the folders of chats
// without a project, over the window's own connection. Mark unread is the
// chat's `conversation.markUnread`, as a phone's or a paired desktop's is. The
// workspace store's sync client, its boot, the sidebar, Diagnostics, New chat
// and the rest-sweep feeds call these. The members keep the names the window
// has always called them by, so a caller changes only where it imports them
// from.

export type WorkspaceSyncApi = {
  workspaceSyncDispatch(command: WorkspaceSyncCommand): Promise<WorkspaceSyncCommandResult>
  workspaceSyncGetSnapshot(): Promise<WorkspaceSyncSnapshot>
  workspaceSyncGetEventsAfter(sequence: number): Promise<WorkspaceSyncEvent[]>
  /** Each change main records, this window's own included (taken once, by its sequence). Returns the unsubscriber. */
  onWorkspaceSyncEvent(cb: (event: WorkspaceSyncEvent) => void): () => void
  workspaceLifecycle(request: WorkspaceLifecycleRequest): Promise<WorkspaceLifecycleResult>
  workspaceMarkUnread(workspaceId: string): Promise<WorkspaceMarkUnreadResult>
  setSettledChatsSettings(settings: SettledChatsSettings): Promise<void>
  setModuleRunStates(states: Record<string, LifecycleState | null>): Promise<void>
  workspaceRegistryNeedsHydration(): Promise<boolean>
  workspaceRegistryHydrate(payload: unknown): Promise<WorkspaceRegistryHydrateResult>
  workspaceBackupWrite(payload: WorkspaceBackupPayload): Promise<WorkspaceBackupWriteResult>
  workspaceBackupRead(): Promise<WorkspaceBackupReadResult>
  projectlessChatsRoot(): Promise<string>
  createProjectlessChatFolder(prompt?: string): Promise<string>
}

/**
 * Whether this page reaches the registry at all: a desktop window or a web
 * tab does. Callers that did nothing without the old IPC member ask this.
 */
export function workspaceSyncReachable(_member: keyof WorkspaceSyncApi): boolean {
  return windowHasStudio()
}

const UNSERVED = 'This Studio does not serve its workspace registry to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** The workspace window this page is, as main named it in the page's address. */
export function thisWorkspaceWindowId(): string {
  if (typeof window === 'undefined') return 'primary'
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}

async function call<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
  capability: StudioCapability = STUDIO_WORKSPACE_SYNC_CAPABILITY,
): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(capability)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A write, under a command id of its own. */
function act<M extends StudioMethod>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
  capability?: StudioCapability,
): Promise<StudioMethodResult<M>> {
  return call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>, capability)
}

export const workspaceSyncApi: WorkspaceSyncApi = {
  workspaceSyncDispatch: async (command) =>
    (await act('workspaceSync.dispatch', {
      windowId: thisWorkspaceWindowId(),
      command: command as unknown as Record<string, unknown>,
    })) as unknown as WorkspaceSyncCommandResult,
  workspaceSyncGetSnapshot: async () => (await call('workspaceSync.snapshot', {})) as unknown as WorkspaceSyncSnapshot,
  workspaceSyncGetEventsAfter: async (sequence) =>
    (await call('workspaceSync.eventsAfter', { sequence })).events as unknown as WorkspaceSyncEvent[],
  onWorkspaceSyncEvent: (cb) =>
    followWindowStudioPush({
      topic: 'workspaceSync.events',
      params: {},
      capability: STUDIO_WORKSPACE_SYNC_CAPABILITY,
      onPayload: (event) => cb(event as unknown as WorkspaceSyncEvent),
    }),
  workspaceLifecycle: async (request) =>
    (await act('workspaceSync.lifecycle', {
      request: request as unknown as Record<string, unknown>,
    })) as unknown as WorkspaceLifecycleResult,
  workspaceMarkUnread: async (workspaceId) => {
    try {
      const marked = await act('conversation.markUnread', { workspaceId }, STUDIO_CHAT_LIFECYCLE_CAPABILITY)
      return { ok: true, workspaceId, lastVisitedAt: marked.lastVisitedAt }
    } catch (error) {
      return {
        ok: false,
        code: error instanceof StudioError ? error.code : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  },
  setSettledChatsSettings: async (settings) => {
    await act('workspaceSync.setSettledChatsSettings', { settings: settings as unknown as Record<string, unknown> })
  },
  setModuleRunStates: async (states) => {
    await act('workspaceSync.setModuleRunStates', { states })
  },
  workspaceRegistryNeedsHydration: async () => (await call('workspaceRegistry.needsHydration', {})).needsHydration,
  workspaceRegistryHydrate: async (payload) =>
    (await act('workspaceRegistry.hydrate', {
      payload: (payload ?? {}) as Record<string, unknown>,
    })) as WorkspaceRegistryHydrateResult,
  workspaceBackupWrite: (payload) => act('workspaceBackup.write', { payload }),
  workspaceBackupRead: () => call('workspaceBackup.read', {}),
  projectlessChatsRoot: async () => (await call('projectlessChats.root', {})).path,
  createProjectlessChatFolder: async (prompt) =>
    (await act('projectlessChats.createFolder', prompt === undefined ? {} : { prompt })).path,
}
