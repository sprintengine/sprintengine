import {
  STUDIO_TAILNET_CAPABILITY,
  type MeshConnection,
  type MeshEvent,
  type MeshLiveState,
  type MeshPairResult,
  type MeshRequestPairingResult,
  type TailnetApprovePairRequestView,
  type TailnetForgetMachineResult,
  type TailnetLiveState,
  type TailnetPairingOfferView,
  type TailnetPeerScan,
  type TailnetPushPayload,
  type TailnetRemoteStatus,
  type TailnetScope,
  type TailnetShareResult,
  type TailnetShareStatus,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to who reaches its Studio over the tailnet, and to the
// machines it drives: the listener (`tailnet.*`, with the `tailnet.changed`
// stream) and pairing with another machine (`mesh.*`, with `mesh.changed`).
// Over the window's own connection, under the names the window's IPC had.
//
// Each is an owner's. Turning the listener or HTTPS on, offering or approving
// a pairing, widening a device, sharing a dev server, finding machines to pair
// with, and every step of pairing with another machine are served to Studio's
// own desktop windows only: a web tab asks and is refused. Reading the
// listener and narrowing it (withdraw, decline, revoke, forget, unshare) are
// an owner's tab's too. The chats on a paired machine are still the window's
// IPC (`window.api.meshConversation*`).

export type TailnetApi = {
  /** The listener: on or off, its address, paired devices, the offer (never its code) and requests waiting. */
  tailnetGetStatus(): Promise<TailnetRemoteStatus>
  tailnetSetEnabled(enabled: boolean): Promise<TailnetRemoteStatus>
  /** Mint a one-time pairing code. The token comes back once and is never re-readable. */
  tailnetOfferPairing(scopes?: TailnetScope[]): Promise<TailnetPairingOfferView>
  tailnetCancelPairing(): Promise<TailnetRemoteStatus>
  tailnetRevokeDevice(deviceId: string): Promise<TailnetRemoteStatus>
  /**
   * Replace a paired device's scopes. The set REPLACES what the device had, so
   * this narrows as readily as it widens. Rejects when no device holds that id.
   */
  tailnetUpdateDeviceScopes(deviceId: string, scopes: TailnetScope[]): Promise<TailnetRemoteStatus>
  /** Publish the listener over HTTPS with Tailscale Serve, or stop; the outcome is in the answer's `mcp.https`. */
  tailnetSetHttps(enabled: boolean): Promise<TailnetRemoteStatus>
  /** Forget every MCP client registration; each client registers afresh before it next signs in. */
  tailnetResetMcpRegistrations(): Promise<TailnetRemoteStatus>
  /**
   * End a pairing in BOTH directions: revoke the device that machine holds
   * here, and forget the credential this machine holds there. An id already
   * gone is not an error; the result says which halves were ended.
   */
  tailnetForgetMachine(input: { deviceId?: string; connectionId?: string }): Promise<TailnetForgetMachineResult>
  /** Answer a pairing request with the scopes chosen here and the six digits on the asker's screen. */
  tailnetApprovePairRequest(id: string, scopes: TailnetScope[], code: string): Promise<TailnetApprovePairRequestView>
  tailnetDenyPairRequest(id: string): Promise<TailnetRemoteStatus>
  /** Machines on this tailnet, and which of them answer as a Studio. Works with the listener off. */
  tailnetListPeers(): Promise<TailnetPeerScan>
  /** Which devices hold a socket right now. */
  tailnetGetLiveState(): Promise<TailnetLiveState>
  /** The listener as it stands, then every change; kept across reconnects. */
  onTailnetEvent(cb: (payload: TailnetPushPayload) => void): () => void
  /** Dev servers this machine publishes on the tailnet, as the daemon reports them now. */
  tailnetShareStatus(): Promise<TailnetShareStatus>
  tailnetSharePort(localPort: number): Promise<TailnetShareResult>
  tailnetUnsharePort(servePort: number): Promise<TailnetShareResult>
  /** The machines this Studio is paired WITH. */
  meshListConnections(): Promise<MeshConnection[]>
  /** Redeem a pairing link from another machine's Settings ▸ Remote. */
  meshPair(pairingUrl: string): Promise<MeshPairResult>
  /**
   * Ask a machine to pair, for someone there to approve. `scopes` is what to
   * ask that machine to let THIS one do (its default when omitted);
   * `reverseScopes` what that machine may do HERE, granted in the same exchange.
   */
  meshRequestPairing(
    endpoint: string,
    options?: { scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] },
  ): Promise<MeshRequestPairingResult>
  meshCancelPairing(requestId: string): Promise<void>
  /** Drop this machine's credential for a peer. Revoking the device THERE is the other half. */
  meshForget(connectionId: string): Promise<MeshConnection[]>
  /** The pairing requests still waiting and each machine's last reachability, with the events' revision. */
  meshGetLiveState(): Promise<MeshLiveState>
  /** The mesh's whole-app facts: as they stand (`current`), then each change; kept across reconnects. */
  onMeshEvent(cb: (event: MeshEvent) => void): () => void
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function served() {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_TAILNET_CAPABILITY)) throw new Error('This Studio does not serve tailnet remote control.')
  return client
}

export const tailnetApi: TailnetApi = {
  tailnetGetStatus: async () => (await served()).request('tailnet.status', {}),
  tailnetSetEnabled: async (enabled) =>
    (await served()).request('tailnet.setEnabled', { enabled, commandId: commandId() }),
  tailnetOfferPairing: async (scopes) =>
    (await served()).request('tailnet.offerPairing', { ...(scopes ? { scopes } : {}), commandId: commandId() }),
  tailnetCancelPairing: async () => (await served()).request('tailnet.cancelPairing', { commandId: commandId() }),
  tailnetRevokeDevice: async (id) => (await served()).request('tailnet.revokeDevice', { id, commandId: commandId() }),
  tailnetUpdateDeviceScopes: async (id, scopes) =>
    (await served()).request('tailnet.updateDeviceScopes', { id, scopes, commandId: commandId() }),
  tailnetSetHttps: async (enabled) => (await served()).request('tailnet.setHttps', { enabled, commandId: commandId() }),
  tailnetResetMcpRegistrations: async () =>
    (await served()).request('tailnet.resetMcpRegistrations', { commandId: commandId() }),
  tailnetForgetMachine: async (input) =>
    (await served()).request('tailnet.forgetMachine', {
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      commandId: commandId(),
    }),
  tailnetApprovePairRequest: async (id, scopes, code) =>
    (await served()).request('tailnet.approvePairRequest', { id, scopes, code, commandId: commandId() }),
  tailnetDenyPairRequest: async (id) =>
    (await served()).request('tailnet.denyPairRequest', { id, commandId: commandId() }),
  tailnetListPeers: async () => (await served()).request('tailnet.peers', {}),
  tailnetGetLiveState: async () => (await served()).request('tailnet.liveState', {}),
  onTailnetEvent: (cb) =>
    followWindowStudioPush({
      topic: 'tailnet.changed',
      params: {},
      capability: STUDIO_TAILNET_CAPABILITY,
      onPayload: cb,
    }),
  tailnetShareStatus: async () => (await served()).request('tailnet.shares', {}),
  tailnetSharePort: async (localPort) =>
    (await served()).request('tailnet.share', { localPort, commandId: commandId() }),
  tailnetUnsharePort: async (servePort) =>
    (await served()).request('tailnet.unshare', { servePort, commandId: commandId() }),
  meshListConnections: async () => (await served()).request('mesh.connections', {}),
  meshPair: async (pairingUrl) => (await served()).request('mesh.pair', { pairingUrl, commandId: commandId() }),
  meshRequestPairing: async (endpoint, options) =>
    (await served()).request('mesh.requestPairing', {
      endpoint,
      // Omitted rather than sent empty when the caller names nothing, so each
      // end's own default stays in force.
      ...(options?.scopes ? { scopes: options.scopes } : {}),
      ...(options?.reverseScopes ? { reverseScopes: options.reverseScopes } : {}),
      commandId: commandId(),
    }),
  meshCancelPairing: async (requestId) => {
    await (await served()).request('mesh.cancelPairing', { requestId, commandId: commandId() })
  },
  meshForget: async (connectionId) => (await served()).request('mesh.forget', { connectionId, commandId: commandId() }),
  meshGetLiveState: async () => (await served()).request('mesh.liveState', {}),
  onMeshEvent: (cb) =>
    followWindowStudioPush({
      topic: 'mesh.changed',
      params: {},
      capability: STUDIO_TAILNET_CAPABILITY,
      onPayload: cb,
    }),
}
