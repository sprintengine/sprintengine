import type * as Containers from './containers'

// A stand-in for chats' containers (`containers.ts`), for tests of
// what calls it. Every suite gets it (`tests/setup.ts` mocks the module with
// this one). A call goes to the member of the same name a suite set on
// `window.api` (the names the window's channels once had); unset, a follow
// hears nothing and anything else rejects, as an unstubbed member did.

type Api = Containers.ContainersApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`containers.${name} is not stubbed in this test`))
}

const fallback: Api = {
  containerDockerStatus: () => notStubbed('containerDockerStatus'),
  containerStartDocker: () => notStubbed('containerStartDocker'),
  containerCreate: () => notStubbed('containerCreate'),
  containersList: () => notStubbed('containersList'),
  containerRemove: () => notStubbed('containerRemove'),
  containerPush: () => notStubbed('containerPush'),
  containerTokenStatus: () => notStubbed('containerTokenStatus'),
  containerTokenSet: () => notStubbed('containerTokenSet'),
  containerTokenClear: () => notStubbed('containerTokenClear'),
  onContainersChanged: () => () => undefined,
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const containersApi: Api = Object.fromEntries(
  (Object.keys(fallback) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (fallback[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api

/** The same stand-in, whatever ticket source a caller names. */
export const createContainersApi = (): Api => containersApi
