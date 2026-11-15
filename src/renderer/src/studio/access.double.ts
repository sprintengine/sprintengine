import type * as Access from './access'

// A stand-in for the window's access family (`access.ts`), for tests of what
// calls it. Every suite gets it (`tests/setup.ts` mocks the module with this
// one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed). Unset, a follow hears nothing and anything else rejects, as an
// unstubbed IPC member did.

type Api = Access.AccessApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`access.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    automationGetStatus: () => notStubbed('automationGetStatus'),
    mcpHttpStatus: () => notStubbed('mcpHttpStatus'),
    mcpHttpCreate: () => notStubbed('mcpHttpCreate'),
    mcpHttpRevoke: () => notStubbed('mcpHttpRevoke'),
    studioLocalAppsStatus: () => notStubbed('studioLocalAppsStatus'),
    studioLocalAppsOffer: () => notStubbed('studioLocalAppsOffer'),
    studioLocalAppsCancelOffer: () => notStubbed('studioLocalAppsCancelOffer'),
    studioLocalAppsRevoke: () => notStubbed('studioLocalAppsRevoke'),
    studioLocalAppsSetReach: () => notStubbed('studioLocalAppsSetReach'),
    onStudioLocalAppsChanged: () => () => undefined,
  }
}

const fallback: Api = blank()

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const accessApi: Api = Object.fromEntries(
  (Object.keys(fallback) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (fallback[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
