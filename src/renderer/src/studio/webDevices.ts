import { STUDIO_WEB_DEVICES_CAPABILITY, type WebDevicesStatus } from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// A web tab's way to the browsers paired with its server's web listener
// (`webDevices.*`, and the `webDevices.changed` stream), over the tab's own
// connection, under the names the tab's tunnel had. Each is an owner's. Only
// a Studio running the web listener offers `web-devices`; a desktop window's
// runs none, so there every read rejects and Settings draws nothing.

export type WebDevicesApi = {
  webDevicesStatus(): Promise<WebDevicesStatus>
  /** Remove a browser: its connections close at once. */
  webDevicesRevoke(id: string): Promise<boolean>
  /** Let a browser in by the six digits it shows. Three wrong tries decline it. */
  webDevicesApprove(requestId: string, code: string): Promise<{ ok: true } | { ok: false; message: string }>
  webDevicesDecline(requestId: string): Promise<boolean>
  /** The status, whole, as it changes; kept across reconnects. */
  onWebDevicesChanged(cb: (status: WebDevicesStatus) => void): () => void
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function served() {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_WEB_DEVICES_CAPABILITY)) throw new Error('This Studio runs no web listener.')
  return client
}

export const webDevicesApi: WebDevicesApi = {
  webDevicesStatus: async () => (await served()).request('webDevices.status', {}),
  webDevicesRevoke: async (id) =>
    (await (await served()).request('webDevices.revoke', { id, commandId: commandId() })).revoked,
  webDevicesApprove: async (requestId, code) =>
    (await served()).request('webDevices.approve', { requestId, code, commandId: commandId() }),
  webDevicesDecline: async (requestId) =>
    (await (await served()).request('webDevices.decline', { requestId, commandId: commandId() })).declined,
  onWebDevicesChanged: (cb) =>
    followWindowStudioPush({
      topic: 'webDevices.changed',
      params: {},
      capability: STUDIO_WEB_DEVICES_CAPABILITY,
      onPayload: cb,
      onReopen: rereadOnReopen(async () => (await served()).request('webDevices.status', {}), cb),
    }),
}
