import type * as Tailnet from './tailnet'

// A stand-in for the window's tailnet family (`tailnet.ts`), for tests of what
// calls it. Every suite gets it (`tests/setup.ts` mocks the module with this
// one); the module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed). Unset, a follow hears nothing and anything else rejects, as an
// unstubbed IPC member did.

type Api = Tailnet.TailnetApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`tailnet.${name} is not stubbed in this test`))
}

// Every member, so one added to the family and not here does not compile.
const fallback: Api = {
  tailnetGetStatus: () => notStubbed('tailnetGetStatus'),
  tailnetSetEnabled: () => notStubbed('tailnetSetEnabled'),
  tailnetOfferPairing: () => notStubbed('tailnetOfferPairing'),
  tailnetCancelPairing: () => notStubbed('tailnetCancelPairing'),
  tailnetRevokeDevice: () => notStubbed('tailnetRevokeDevice'),
  tailnetUpdateDeviceScopes: () => notStubbed('tailnetUpdateDeviceScopes'),
  tailnetSetHttps: () => notStubbed('tailnetSetHttps'),
  tailnetResetMcpRegistrations: () => notStubbed('tailnetResetMcpRegistrations'),
  tailnetForgetMachine: () => notStubbed('tailnetForgetMachine'),
  tailnetApprovePairRequest: () => notStubbed('tailnetApprovePairRequest'),
  tailnetDenyPairRequest: () => notStubbed('tailnetDenyPairRequest'),
  tailnetListPeers: () => notStubbed('tailnetListPeers'),
  tailnetGetLiveState: () => notStubbed('tailnetGetLiveState'),
  onTailnetEvent: () => () => undefined,
  tailnetShareStatus: () => notStubbed('tailnetShareStatus'),
  tailnetSharePort: () => notStubbed('tailnetSharePort'),
  tailnetUnsharePort: () => notStubbed('tailnetUnsharePort'),
  meshListConnections: () => notStubbed('meshListConnections'),
  meshPair: () => notStubbed('meshPair'),
  meshRequestPairing: () => notStubbed('meshRequestPairing'),
  meshCancelPairing: () => notStubbed('meshCancelPairing'),
  meshForget: () => notStubbed('meshForget'),
  meshGetLiveState: () => notStubbed('meshGetLiveState'),
  onMeshEvent: () => () => undefined,
}

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const tailnetApi: Api = Object.fromEntries(
  (Object.keys(fallback) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (fallback[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
