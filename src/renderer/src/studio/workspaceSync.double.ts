import type * as WorkspaceSync from './workspaceSync'

// A stand-in for the window's workspace registry (`workspaceSync.ts`), for
// tests of what calls it. Every suite gets it (`tests/setup.ts` mocks the
// module with this one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `workspaceSyncDouble`'s, which a suite may set too. Unset,
// a follow hears nothing and anything else rejects, as an unstubbed IPC member
// did; and the registry is reachable only where a suite stubbed or set the
// member, as the old member's presence decided.

type Api = WorkspaceSync.WorkspaceSyncApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`workspaceSync.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    workspaceSyncDispatch: () => notStubbed('workspaceSyncDispatch'),
    workspaceSyncGetSnapshot: () => notStubbed('workspaceSyncGetSnapshot'),
    workspaceSyncGetEventsAfter: () => notStubbed('workspaceSyncGetEventsAfter'),
    onWorkspaceSyncEvent: () => () => undefined,
    workspaceLifecycle: () => notStubbed('workspaceLifecycle'),
    workspaceMarkUnread: () => notStubbed('workspaceMarkUnread'),
    setSettledChatsSettings: () => notStubbed('setSettledChatsSettings'),
    setModuleRunStates: () => notStubbed('setModuleRunStates'),
    workspaceRegistryNeedsHydration: () => notStubbed('workspaceRegistryNeedsHydration'),
    workspaceRegistryHydrate: () => notStubbed('workspaceRegistryHydrate'),
    workspaceBackupWrite: () => notStubbed('workspaceBackupWrite'),
    workspaceBackupRead: () => notStubbed('workspaceBackupRead'),
    projectlessChatsRoot: () => notStubbed('projectlessChatsRoot'),
    createProjectlessChatFolder: () => notStubbed('createProjectlessChatFolder'),
  }
}

const BLANK = blank()

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const workspaceSyncDouble: Api = blank()

/** Put every member back as it was. */
export function resetWorkspaceSyncDouble(): void {
  Object.assign(workspaceSyncDouble, BLANK)
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export function workspaceSyncReachable(member: keyof Api): boolean {
  return stubbed(member) !== null || workspaceSyncDouble[member] !== BLANK[member]
}

export function thisWorkspaceWindowId(): string {
  if (typeof window === 'undefined') return 'primary'
  try {
    return new URL(window.location.href).searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}

export const workspaceSyncApi: Api = Object.fromEntries(
  (Object.keys(BLANK) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (workspaceSyncDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
