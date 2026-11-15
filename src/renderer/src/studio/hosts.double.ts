import type * as Hosts from './hosts'

// A stand-in for the machines this computer offers (`hosts.ts`), for tests of
// what calls it. Every suite gets it (`tests/setup.ts` mocks the module with
// this one). A call goes to the member of the same name a suite set on
// `window.api` (the names the window's channels once had); unset, a follow
// hears nothing and anything else rejects, as an unstubbed member did.

type Api = Hosts.HostsApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`hosts.${name} is not stubbed in this test`))
}

const fallback: Api = {
  hostsList: () => notStubbed('hostsList'),
  hostsHome: () => notStubbed('hostsHome'),
  onHostsChanged: () => () => undefined,
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const hostsApi: Api = Object.fromEntries(
  (Object.keys(fallback) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (fallback[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
