import type * as WebDevices from './webDevices'

// A stand-in for a web tab's paired browsers (`webDevices.ts`), for tests of
// what calls it. Every suite gets it (`tests/setup.ts` mocks the module with
// this one). A call goes to the member of the same name a suite set on
// `window.api` (the names the tab's tunnel once had); unset, a follow hears
// nothing and anything else rejects, as an unstubbed member did.

type Api = WebDevices.WebDevicesApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`webDevices.${name} is not stubbed in this test`))
}

const fallback: Api = {
  webDevicesStatus: () => notStubbed('webDevicesStatus'),
  webDevicesRevoke: () => notStubbed('webDevicesRevoke'),
  webDevicesApprove: () => notStubbed('webDevicesApprove'),
  webDevicesDecline: () => notStubbed('webDevicesDecline'),
  onWebDevicesChanged: () => () => undefined,
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const webDevicesApi: Api = Object.fromEntries(
  (Object.keys(fallback) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (fallback[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
