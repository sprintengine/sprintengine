import {
  STUDIO_ACCESS_CAPABILITY,
  type AutomationServerStatus,
  type McpHttpCreateResult,
  type McpHttpStatus,
  type StudioLocalAppOfferInput,
  type StudioLocalAppOfferView,
  type StudioLocalAppsStatus,
  type StudioLocalAppToolReach,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to who may reach its Studio's agents from that machine:
// the gateway's status (`gateway.status`), the tokens its loopback HTTP
// endpoint admits (`mcpHttp.*`), and the apps paired with its owner socket
// (`localApps.*`, with the `localApps.changed` stream). Over the window's own
// connection, under the names the window's IPC had.
//
// Each is an owner's. Minting an HTTP token and all of local app pairing are
// served to Studio's own desktop windows only: a web tab asks and is refused,
// so Settings offers neither there.

export type AccessApi = {
  automationGetStatus(): Promise<AutomationServerStatus>
  /** The gateway's loopback HTTP endpoint: where it listens and the clients given a token. */
  mcpHttpStatus(): Promise<McpHttpStatus>
  /** Make a token for a named client; the token comes back this once and is kept only hashed. */
  mcpHttpCreate(name: string): Promise<McpHttpCreateResult>
  mcpHttpRevoke(id: string): Promise<McpHttpStatus>
  /** The apps on this machine paired with Studio's owner socket. */
  studioLocalAppsStatus(): Promise<StudioLocalAppsStatus>
  /** Mint a one-time pairing code for an app. The code comes back once and is never re-readable. */
  studioLocalAppsOffer(input: StudioLocalAppOfferInput): Promise<StudioLocalAppOfferView>
  studioLocalAppsCancelOffer(id: string): Promise<StudioLocalAppsStatus>
  /** Revoke an app: its token stops working and its open connections are closed at once. */
  studioLocalAppsRevoke(id: string): Promise<StudioLocalAppsStatus>
  /** Change which agents a paired app's tools reach: the chats it starts, or every agent here. */
  studioLocalAppsSetReach(id: string, reach: StudioLocalAppToolReach): Promise<StudioLocalAppsStatus>
  /** The paired apps, whole, as they change; kept across reconnects. */
  onStudioLocalAppsChanged(cb: (status: StudioLocalAppsStatus) => void): () => void
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function served() {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_ACCESS_CAPABILITY)) throw new Error('This Studio does not say who may reach it.')
  return client
}

export const accessApi: AccessApi = {
  automationGetStatus: async () => (await served()).request('gateway.status', {}),
  mcpHttpStatus: async () => (await served()).request('mcpHttp.status', {}),
  mcpHttpCreate: async (name) => (await served()).request('mcpHttp.create', { name, commandId: commandId() }),
  mcpHttpRevoke: async (id) => (await served()).request('mcpHttp.revoke', { id, commandId: commandId() }),
  studioLocalAppsStatus: async () => (await served()).request('localApps.status', {}),
  studioLocalAppsOffer: async (input) => (await served()).request('localApps.offer', { input, commandId: commandId() }),
  studioLocalAppsCancelOffer: async (id) =>
    (await served()).request('localApps.cancelOffer', { id, commandId: commandId() }),
  studioLocalAppsRevoke: async (id) => (await served()).request('localApps.revoke', { id, commandId: commandId() }),
  studioLocalAppsSetReach: async (id, reach) =>
    (await served()).request('localApps.setReach', { id, reach, commandId: commandId() }),
  onStudioLocalAppsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'localApps.changed',
      params: {},
      capability: STUDIO_ACCESS_CAPABILITY,
      onPayload: cb,
      onReopen: rereadOnReopen(async () => (await served()).request('localApps.status', {}), cb),
    }),
}
