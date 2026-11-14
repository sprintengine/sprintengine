import type * as Worktrees from './worktrees'

// A stand-in for the window's worktrees (`worktrees.ts`), for tests of what
// calls it. Every suite gets it (`tests/setup.ts` mocks the module with this
// one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `worktreesDouble`'s, which a suite may set too. Unset, a
// follow hears nothing and anything else rejects, as an unstubbed IPC member did.

type Api = Worktrees.WorktreesApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`worktrees.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    getWorktreePoolSnapshot: () => notStubbed('getWorktreePoolSnapshot'),
    onWorktreePoolChanged: () => () => undefined,
    worktreePoolAction: () => notStubbed('worktreePoolAction'),
    removeOtherWorktree: () => notStubbed('removeOtherWorktree'),
    getWorktreePoolSettings: () => notStubbed('getWorktreePoolSettings'),
    setWorktreePoolSettings: () => notStubbed('setWorktreePoolSettings'),
    getWorktreeInventory: () => notStubbed('getWorktreeInventory'),
    listWorktreeInstalls: () => notStubbed('listWorktreeInstalls'),
    onWorktreeInstallChanged: () => () => undefined,
    cancelWorktreeInstall: () => notStubbed('cancelWorktreeInstall'),
    createGitWorktree: () => notStubbed('createGitWorktree'),
    restoreGitWorktree: () => notStubbed('restoreGitWorktree'),
    removeGitWorktree: () => notStubbed('removeGitWorktree'),
    cleanupAgentWorktrees: () => notStubbed('cleanupAgentWorktrees'),
    planSettledChatDeletion: () => notStubbed('planSettledChatDeletion'),
    deleteSettledChats: () => notStubbed('deleteSettledChats'),
  }
}

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const worktreesDouble: Api = blank()

/** Put every member back as it was. */
export function resetWorktreesDouble(): void {
  Object.assign(worktreesDouble, blank())
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const worktreesApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (worktreesDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
