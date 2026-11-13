import type * as Backlog from './backlog'

// A stand-in for the window's backlog by folder (`backlog.ts`), for tests of
// what calls it. Every suite gets it (`tests/setup.ts` mocks the module with
// this one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `backlogDouble`'s, which a suite may set too. Unset, it
// rejects, as an unstubbed IPC member did.

type Api = Backlog.BacklogApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`backlog.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    resolveBacklogLocation: () => notStubbed('resolveBacklogLocation'),
    setBacklogRoot: () => notStubbed('setBacklogRoot'),
    ensureBacklogObjectRecords: () => notStubbed('ensureBacklogObjectRecords'),
    ensureBacklogItemIds: () => notStubbed('ensureBacklogItemIds'),
    updateBacklogStatus: () => notStubbed('updateBacklogStatus'),
    updateBacklogTriage: () => notStubbed('updateBacklogTriage'),
    updateBacklogHighlight: () => notStubbed('updateBacklogHighlight'),
    addOrUpdateBacklogLink: () => notStubbed('addOrUpdateBacklogLink'),
    removeBacklogLink: () => notStubbed('removeBacklogLink'),
    updateBacklogModuleMetadata: () => notStubbed('updateBacklogModuleMetadata'),
    moveBacklogObjectSource: () => notStubbed('moveBacklogObjectSource'),
    removeBacklogObjectRecord: () => notStubbed('removeBacklogObjectRecord'),
    updateBacklogEpic: () => notStubbed('updateBacklogEpic'),
    updateBacklogEpicColor: () => notStubbed('updateBacklogEpicColor'),
    updateBacklogDependencies: () => notStubbed('updateBacklogDependencies'),
    updateBacklogMockups: () => notStubbed('updateBacklogMockups'),
    createBacklogEpic: () => notStubbed('createBacklogEpic'),
  }
}

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const backlogDouble: Api = blank()

/** Put every member back as it was. */
export function resetBacklogDouble(): void {
  Object.assign(backlogDouble, blank())
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const backlogApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (backlogDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
