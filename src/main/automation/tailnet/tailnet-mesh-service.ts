import { randomBytes } from 'crypto'

import { hashSecret } from './secret-hash'
import { hostname } from 'os'

import type { EnvironmentTicketResult } from '../../../shared/environments'
import {
  normalizeTailnetScopes,
  tailnetScopeGrantsAccess,
  type TailnetDevice,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import {
  type MeshConnection,
  type MeshEvent,
  type MeshLiveState,
  type MeshMachineReachability,
  type MeshPairRequestPhase,
  type MeshPairResult,
  type MeshCollectPairingResult,
  type MeshPairRequestView,
  type MeshRequestPairingResult,
  type MeshForgetMachineResult,
} from '../../../shared/tailnet-mesh'
import { createTailnetMeshStore, type StoredMeshConnection, type TailnetMeshStore } from './tailnet-mesh-store'
import type { TailnetPeerIdentity } from './tailnet-peer-identity'
import { createPeerStudios, peerRefusal, peerStudioTicket, type PeerStudioTarget } from './tailnet-peer-studio'
import type { UsageWireArgs } from '../../../../packages/studio-protocol/src/chat-stores'
import {
  formatTailnetEndpoint,
  collectPairingFromMachine,
  pairWithMachine,
  parsePairingUrl,
  requestPairingFromMachine,
  type TailnetEndpoint,
  parseTailnetEndpoint,
  readRemoteIdentity,
  type RemoteIdentity,
} from './tailnet-remote-client'
import { powerActivity, type PowerActivity } from '../../power-activity'

// The Mesh: this Studio driving other machines.
//
// The machines this Studio is paired with: pairing and forgetting them, whether
// each answers, and the tickets a window spends to reach each one's Studio
// itself (design-lane-on-protocol D1), with the device tokens kept in main. A
// window never holds a credential; what it asks of a paired machine (its
// chats, what it holds, its boards) it asks that machine's Studio directly.

// ── Staying paired (pair-from-the-scan-and-stay-paired, phases 3, 4, 6) ─────
//
// Main owns the wait on a request this machine made, so closing the panel
// that asked does not abandon it; main checks whether each paired machine
// answers, on the moments that change the answer, so a machine with no pane
// open is not shown as merely "paired" forever; and a request may carry the
// reverse half of a both-ways pairing, minted here for the machine asked.

/**
 * How often a waiting request asks the other machine for an answer. Slow on
 * purpose: the thing being waited on is a person walking to a computer, and
 * every poll is a round trip to a real machine.
 */
const DEFAULT_PAIR_POLL_MS = 2000
/**
 * How long past the other machine's own expiry a request keeps polling
 * before it is called expired HERE — for the case where that machine went
 * to sleep and cannot say so itself.
 */
const PAIR_WAIT_GRACE_MS = 15_000
/**
 * Every paired machine is checked this often while a window is open. Five
 * minutes is a row that is right within a coffee's length, at one small
 * authenticated call per machine per interval.
 */
const DEFAULT_REACHABILITY_INTERVAL_MS = 5 * 60_000
/** A check must be cheap for a sleeping laptop too: three seconds, not the browse's ten. */
const DEFAULT_REACHABILITY_TIMEOUT_MS = 3_000

export type TailnetMeshService = {
  /**
   * Begin the reachability supervisor (phase 4): one check of every paired
   * machine now, and one per interval from here on. Idempotent.
   */
  start(): void
  /**
   * The machine woke, or came back on a network (phase 4): check every
   * paired machine now, and re-dial every watch and followed conversation
   * that was waiting out a backoff — a lid opening should reconnect at once,
   * not in a minute.
   */
  onWake(): void
  /**
   * Check whether one paired machine (or every one) answers right now, and
   * report the state after. The row's Retry.
   */
  checkReachability(connectionId?: unknown): Promise<MeshLiveState>
  listConnections(): MeshConnection[]
  pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<MeshPairResult>
  /**
   * Ask a machine to pair and wait for someone there to approve it.
   *
   * The outward half stays main's for the same reason `pair` does: the listener
   * refuses any request carrying an `Origin` header, so a window physically
   * cannot dial a peer. The collect secret lives here and is never handed to a
   * renderer. Main also owns the WAIT (phase 3): the poll runs here until the
   * request is answered, lapses, or is cancelled, and every phase is broadcast
   * as a `pair-request` mesh event.
   *
   * `scopes` is what this machine asks to be allowed to do THERE;
   * `reverseScopes` (phase 6) offers the machine asked a device HERE with those
   * scopes, so approving over there pairs both ways in the one exchange.
   * Refused when this machine's own listener is not running: a grant to a
   * listener that is down is a credential pointing at nothing.
   */
  requestPairing(input: {
    endpoint: unknown
    deviceName?: unknown
    /**
     * What to ask that machine to let THIS one do — the outbound half. Sent
     * with the request so the person answering sees the set that was asked
     * for; they still decide what is granted. Absent leaves the far end's
     * default (every scope, `TAILNET_SCOPES`) in force.
     */
    scopes?: unknown
    reverseScopes?: unknown
  }): Promise<MeshRequestPairingResult>
  /**
   * Poll one request we made, now, and report. The timer polls on its own;
   * this is the one-off a surface may ask for. Lands the connection when
   * the request has been approved.
   */
  collectPairing(requestId: unknown): Promise<MeshCollectPairingResult>
  /** Forget a request we made. The far end's copy lapses on its own; a reverse device minted for it is revoked. */
  cancelPairing(requestId: unknown): void
  /**
   * Adopt the reverse half of a both-ways pairing another machine offered
   * when it asked to drive THIS one (phase 6): the gateway has verified the
   * grant's endpoint is the asker's own address, and a person here approved
   * the request it rode in on. Stored as a machine this Studio can drive.
   */
  adoptReverseGrant(input: {
    grant: TailnetReverseGrant
    askerName: string
    peerNode: string | null
  }): MeshConnection | null
  forget(connectionId: unknown): MeshConnection[]
  /**
   * End a pairing in both directions (remote-settings-rebuild).
   *
   * A person looking at a machine in Settings sees one relationship, not two
   * credentials; Revoke there must not leave the other half live. Either id may
   * be absent — a machine that only ever drove this one has no connection here,
   * and one this machine only ever drove has no device here — and an id that is
   * already gone is not an error, because "we are not paired any more" is the
   * state the caller asked for and the state it gets.
   */
  forgetMachine(input: { deviceId?: unknown; connectionId?: unknown }): MeshForgetMachineResult
  /**
   * A desktop window's ticket for one connection to a paired machine's
   * Studio, bought with the device token kept here: good once, for thirty
   * seconds, from the window's `origin` alone. The window spends it and keeps
   * nothing; the token never leaves this process.
   */
  windowTicket(connectionId: unknown, origin: string): Promise<EnvironmentTicketResult>
  /**
   * The requests still waiting and each machine's last reachability answer,
   * stamped with the same revision the events carry — the initial read behind
   * `onEvent`, so a window that mounts mid-wait is not stuck on "paired".
   */
  getLiveState(): MeshLiveState
  /**
   * One machine's usage over a window, for this desktop's usage dashboard
   * (`usage-report`, on `workspace:read`). The handshake comes first, so a
   * machine that is away, revoked, or on a Studio without the tool is told
   * apart before anything is asked; the arguments go as they are, and the
   * answer comes back unread (usage-mesh.ts reads it).
   */
  readUsage(input: {
    connectionId: unknown
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<MeshUsageResult>
  shutdown(): void
}

/** What one machine answered `usage.report`, or why it did not: away, on an older Studio, refused, or failing. */
export type MeshUsageResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 'offline' | 'unsupported' | 'unauthorized' | 'error'; message: string }

/** How long a usage read gives a machine to say who it is: a sleeping laptop should not hold the dashboard's ask. */
const USAGE_IDENTITY_TIMEOUT_MS = 5_000

export type TailnetMeshServiceOptions = {
  resolveUserDataDir: () => string
  /** This machine's name, as the other end will list the pairing. */
  resolveDeviceName?: () => string
  /** Tailscale node name for an address, so a machine is listed by name rather than by IP. */
  resolvePeerName?: (address: string) => Promise<string | null>
  /**
   * The whole whois answer for an address. A reverse device is bound to the
   * node it names, so only the machine being asked can use that grant.
   */
  resolvePeerIdentity?: (address: string) => Promise<TailnetPeerIdentity | null>
  /**
   * Whole-app mesh lifecycle for the live-state push (remote-sessions-ux):
   * a machine paired or forgotten, answering or not, a request's wait moving
   * on. These are the facts chrome in every window may show. Payloads never
   * carry a credential — connections cross this boundary as the store's
   * public view.
   */
  onEvent?: (event: MeshEvent) => void
  /**
   * Mint a device on THIS machine's listener for a machine it is asking to
   * drive (phase 6). Null when nothing is listening here. Absent in a build
   * with no listener at all, which simply never offers the reverse half.
   */
  mintReverseDevice?: (input: {
    machineName: string
    scopes: TailnetScope[]
    /** whois for the machine being asked; null leaves the device to bind on first use. */
    peer?: TailnetPeerIdentity | null
  }) => {
    device: TailnetDevice
    deviceToken: string
    endpoint: string
  } | null
  /** Take back a reverse device when the request it was minted for did not complete. */
  revokeReverseDevice?: (deviceId: string) => void
  /**
   * Revoke a device on THIS machine's listener, whatever minted it.
   *
   * Distinct from `revokeReverseDevice`, which undoes a grant this service
   * itself just made when a request failed. This is the inbound half of
   * `forgetMachine`, and it may be a device that arrived by carried code or by
   * approval — nothing this service ever created. Returns whether a device was
   * actually there, so the caller can report which halves it ended.
   */
  revokeInboundDevice?: (deviceId: string) => boolean
  /**
   * Whether a window someone could be looking at is open: the reachability
   * timer, and the re-checks of a machine that stopped answering, only run
   * while one is. Defaults to always.
   */
  hasWindow?: () => boolean
  /** Focus, lock and battery, for the loops above; the process-wide instance unless a test passes its own. */
  activity?: Pick<PowerActivity, 'isOnBattery' | 'isScreenLocked' | 'onFocusChange'>
  /** Injected in tests, which cannot wait minutes. */
  pairPollMs?: number
  reachabilityIntervalMs?: number
  reachabilityTimeoutMs?: number
  createStore?: (options: { resolveUserDataDir: () => string; log?: (message: string) => void }) => TailnetMeshStore
  log?: (message: string) => void
}

/** A mesh event before the service stamps its revision — distributed over the union, member by member. */
type MeshEventBody = MeshEvent extends infer E ? (E extends MeshEvent ? Omit<E, 'revision'> : never) : never

export function createTailnetMeshService(options: TailnetMeshServiceOptions): TailnetMeshService {
  const store = (options.createStore ?? createTailnetMeshStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const deviceName = () => (options.resolveDeviceName ?? defaultDeviceName)()
  const pairPollMs = Math.max(50, options.pairPollMs ?? DEFAULT_PAIR_POLL_MS)
  const reachabilityIntervalMs = Math.max(50, options.reachabilityIntervalMs ?? DEFAULT_REACHABILITY_INTERVAL_MS)
  const reachabilityTimeoutMs = Math.max(50, options.reachabilityTimeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS)
  const activity = options.activity ?? powerActivity
  /** Someone could be looking: a window is up and the screen is not locked. */
  const someoneLooking = (): boolean => (options.hasWindow?.() ?? true) && !activity.isScreenLocked()
  // Stamped on every broadcast and every snapshot; only ever goes up, so a
  // subscriber can order a late initial read against events already applied.
  let revision = 0
  const broadcast = (event: MeshEventBody): void => {
    revision += 1
    options.onEvent?.({ ...event, revision })
  }

  function connectionFor(connectionId: unknown): StoredMeshConnection | null {
    return typeof connectionId === 'string' ? store.find(connectionId) : null
  }
  async function pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<MeshPairResult> {
    const raw = typeof input.pairingUrl === 'string' ? input.pairingUrl : ''
    const parsed = parsePairingUrl(raw)
    if (!parsed) {
      return {
        ok: false,
        code: 'invalid_pairing_link',
        message: "That is not a pairing link. Copy the whole link from the other machine's Settings → Remote.",
      }
    }
    const name =
      typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
    if (!name) {
      return {
        ok: false,
        code: 'device_name_required',
        message: 'This machine has no name to pair under. Name it and try again.',
      }
    }
    const paired = await pairWithMachine({
      endpoint: parsed.endpoint,
      pairingToken: parsed.pairingToken,
      deviceName: name,
    })
    if (!paired.ok) return { ok: false, code: paired.code, message: paired.message }

    // Named by Tailscale where it can be — an address is a correct label and a
    // useless one. The address stays as the fallback rather than an invented name.
    const peerName = (await options.resolvePeerName?.(parsed.endpoint.host).catch(() => null)) ?? null
    try {
      const connection = store.add({
        machineName: peerName ?? parsed.endpoint.host,
        endpoint: formatTailnetEndpoint(parsed.endpoint),
        deviceId: paired.value.deviceId,
        deviceName: paired.value.deviceName,
        deviceToken: paired.value.deviceToken,
        scopes: paired.value.scopes,
        pairedVia: 'link',
      })
      broadcast({ kind: 'machine-paired', connection })
      syncReachabilityTimer()
      // It just answered a pairing, so it is reachable — recorded rather
      // than left for the next timer to discover.
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
      return { ok: true, connection }
    } catch (error) {
      // The device now exists on the other machine. Saying "paired" over a token
      // we could not keep would leave a live grant nothing here can name — so
      // say exactly what happened and what to do about it.
      return {
        ok: false,
        code: 'pairing_not_saved',
        message:
          `Paired with ${formatTailnetEndpoint(parsed.endpoint)}, but the credential could not be saved here ` +
          `(${message(error)}). Revoke this device on that machine and pair again.`,
      }
    }
  }

  // Requests this machine has made and is waiting on. In memory, like the
  // target's own pending list: a request that outlived a restart would be
  // waiting on a moment nobody is still in. The poll lives HERE (phase 3),
  // so the wait outlives whichever panel asked.
  type OutboundRequest = {
    endpoint: TailnetEndpoint
    collectSecret: string
    view: MeshPairRequestView
    /** The reverse half offered to the machine asked (phase 6), or null. */
    reverse: TailnetReverseGrant | null
    timer: ReturnType<typeof setTimeout> | null
    /** A poll is on the wire; the timer must not stack a second. */
    polling: Promise<void> | null
  }
  const outboundRequests = new Map<string, OutboundRequest>()
  // How each request this session ended, so a surface that asks late (a
  // panel that was closed while the answer landed) hears the answer rather
  // than "expired". Bounded: a session makes a handful of requests, ever.
  const settledRequests = new Map<string, MeshCollectPairingResult>()

  function announceRequest(
    request: OutboundRequest,
    phase: MeshPairRequestPhase,
    extra: { connection?: MeshConnection; detail?: string } = {},
  ): void {
    broadcast({ kind: 'pair-request', phase, request: { ...request.view }, ...extra })
  }

  /** End a request here: stop its timer, take back its reverse device, and drop it. */
  function endRequest(request: OutboundRequest, keepReverse: boolean, settled?: MeshCollectPairingResult): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    outboundRequests.delete(request.view.requestId)
    if (settled) settledRequests.set(request.view.requestId, settled)
    if (request.reverse && !keepReverse) {
      // The device was minted for a pairing that did not complete; leaving it
      // would leave a live grant on this machine that nothing names.
      try {
        options.revokeReverseDevice?.(request.reverse.deviceId)
      } catch (error) {
        options.log?.(`Could not revoke reverse device ${request.reverse.deviceId}: ${message(error)}`)
      }
    }
  }

  function scheduleRequestPoll(request: OutboundRequest): void {
    if (request.timer || !outboundRequests.has(request.view.requestId)) return
    request.timer = setTimeout(() => {
      request.timer = null
      void pollRequest(request)
    }, pairPollMs)
    request.timer.unref?.()
  }

  /** One poll of one request. Resolves when the answer has been applied and announced. */
  function pollRequest(request: OutboundRequest): Promise<void> {
    if (request.polling) return request.polling
    if (!outboundRequests.has(request.view.requestId)) return Promise.resolve()
    request.polling = (async () => {
      const collected = await collectPairingFromMachine({
        endpoint: request.endpoint,
        requestId: request.view.requestId,
        collectSecret: request.collectSecret,
        reverse: request.reverse,
      })
      // Cancelled while the poll was on the wire: whatever it says is moot.
      if (!outboundRequests.has(request.view.requestId)) return
      if (!collected.ok) {
        // A machine that went to sleep mid-wait is not a refusal — keep
        // waiting until its own expiry has clearly passed, then call it.
        const expiresAtMs = Date.parse(request.view.expiresAt)
        if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs + PAIR_WAIT_GRACE_MS) {
          endRequest(request, false, { ok: true, status: 'expired' })
          announceRequest(request, 'expired', { detail: collected.message })
          return
        }
        scheduleRequestPoll(request)
        return
      }
      const outcome = collected.value
      if (outcome.status === 'pending') {
        // The far end restates the code and expiry on every poll; keep them
        // current so a card that mounts late shows what is on the other screen.
        request.view = { ...request.view, comparisonCode: outcome.comparisonCode, expiresAt: outcome.expiresAt }
        scheduleRequestPoll(request)
        return
      }
      if (outcome.status !== 'approved') {
        endRequest(request, false, { ok: true, status: outcome.status })
        announceRequest(request, outcome.status, {
          detail:
            outcome.status === 'denied'
              ? `${request.view.machineName} declined the request.`
              : 'The request lapsed before anyone answered it.',
        })
        return
      }
      let connection: MeshConnection
      try {
        connection = store.add({
          machineName: request.view.machineName,
          endpoint: request.view.endpoint,
          deviceId: outcome.deviceId,
          deviceName: outcome.deviceName,
          deviceToken: outcome.deviceToken,
          scopes: outcome.scopes,
          pairedVia: 'request',
        })
      } catch (error) {
        // Same failure the carried-code path has, and the same honesty about it:
        // the device exists over there now, and nothing here can name it. The
        // reverse device stays, though — the other machine now holds its token
        // and will list it, so it must be revocable by name here.
        const detail =
          `${request.view.machineName} approved the request, but the credential could not be saved here ` +
          `(${message(error)}). Revoke this device on that machine and ask again.`
        endRequest(request, true, { ok: false, code: 'pairing_not_saved', message: detail })
        announceRequest(request, 'failed', { detail })
        return
      }
      endRequest(request, true, { ok: true, status: 'approved', connection })
      broadcast({ kind: 'machine-paired', connection })
      syncReachabilityTimer()
      announceRequest(request, 'approved', { connection })
      recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    })().finally(() => {
      request.polling = null
    })
    return request.polling
  }

  async function requestPairing(input: {
    endpoint: unknown
    deviceName?: unknown
    scopes?: unknown
    reverseScopes?: unknown
  }): Promise<MeshRequestPairingResult> {
    const endpoint = parseTailnetEndpoint(typeof input.endpoint === 'string' ? input.endpoint : '')
    if (!endpoint) {
      return { ok: false, code: 'invalid_endpoint', message: 'That is not a machine address this can dial.' }
    }
    const name =
      typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
    if (!name) {
      return {
        ok: false,
        code: 'device_name_required',
        message: 'This machine has no name to pair under. Name it and try again.',
      }
    }
    // One request per machine at a time, from here: the far end refuses a
    // second anyway, and two cards waiting on one machine would be two
    // codes for one approval.
    for (const pending of outboundRequests.values()) {
      if (formatTailnetEndpoint(pending.endpoint) === formatTailnetEndpoint(endpoint)) {
        return {
          ok: false,
          code: 'already_waiting',
          message: `A request to ${pending.view.machineName} is already waiting to be answered.`,
        }
      }
    }
    // Asked only when a reverse half will be minted: that device is bound to
    // the node being asked, which is the one that will present its token.
    const peerIdentity =
      input.reverseScopes === undefined
        ? null
        : ((await options.resolvePeerIdentity?.(endpoint.host).catch(() => null)) ?? null)
    const peerName = peerIdentity?.name ?? (await options.resolvePeerName?.(endpoint.host).catch(() => null)) ?? null
    const machineName = peerName ?? endpoint.host

    // The reverse half first (phase 6): minted before the ask so a listener
    // that is down refuses the whole thing rather than half of it. Only when
    // asked for — a phone, or a person who wants one direction, offers none.
    let reverse: TailnetReverseGrant | null = null
    const reverseScopes = input.reverseScopes === undefined ? null : normalizeTailnetScopes(input.reverseScopes)
    if (reverseScopes) {
      if (!options.mintReverseDevice) {
        return {
          ok: false,
          code: 'reverse_unavailable',
          message: 'This machine cannot be driven back: it has no listener to grant.',
        }
      }
      const minted = options.mintReverseDevice({ machineName, scopes: reverseScopes, peer: peerIdentity })
      if (!minted) {
        return {
          ok: false,
          code: 'reverse_unavailable',
          message:
            'Turn on Remote here first, or ask without letting that machine drive this one. A grant to a listener that is not running would point at nothing.',
        }
      }
      reverse = {
        endpoint: minted.endpoint,
        machineName: name,
        deviceId: minted.device.id,
        deviceName: minted.device.name,
        deviceToken: minted.deviceToken,
        scopes: minted.device.scopes,
      }
    }

    // The secret stays here; only its hash is sent. Collecting the token later
    // means presenting it, so knowing the request id is not enough to take it.
    const collectSecret = randomBytes(24).toString('base64url')
    // Undefined, not an empty array, when nothing was asked for: the far end's
    // default is the one that applies, and an empty list would read as a
    // request for no access at all.
    const requestScopes = input.scopes === undefined ? undefined : normalizeTailnetScopes(input.scopes)
    const asked = await requestPairingFromMachine({
      endpoint,
      deviceName: name,
      collectHash: hashSecret(collectSecret),
      ...(requestScopes && requestScopes.length > 0 ? { scopes: requestScopes } : {}),
    })
    if (!asked.ok) {
      if (reverse) options.revokeReverseDevice?.(reverse.deviceId)
      return { ok: false, code: asked.code, message: asked.message }
    }

    const view: MeshPairRequestView = {
      requestId: asked.value.requestId,
      endpoint: formatTailnetEndpoint(endpoint),
      machineName,
      comparisonCode: asked.value.comparisonCode,
      expiresAt: asked.value.expiresAt,
      reverseOffered: reverse !== null,
    }
    const request: OutboundRequest = { endpoint, collectSecret, view, reverse, timer: null, polling: null }
    outboundRequests.set(view.requestId, request)
    announceRequest(request, 'waiting')
    scheduleRequestPoll(request)
    return { ok: true, request: view }
  }

  async function collectPairing(requestId: unknown): Promise<MeshCollectPairingResult> {
    const id = typeof requestId === 'string' ? requestId : ''
    const pending = outboundRequests.get(id)
    if (!pending) {
      // Already ended here: say how. Nothing at all under that id — a
      // restart, or an id from another window — reads as expired, which is
      // what it is to this process.
      return settledRequests.get(id) ?? { ok: true, status: 'expired' }
    }
    // Poll now rather than waiting for the timer, then report what the poll
    // applied — the same path the timer takes, so a surface asking cannot
    // race the broadcast to a different answer.
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    await pollRequest(pending)
    if (outboundRequests.has(id)) return { ok: true, status: 'pending', request: { ...pending.view } }
    return settledRequests.get(id) ?? { ok: true, status: 'expired' }
  }

  function cancelPairing(requestId: unknown): void {
    const pending = outboundRequests.get(typeof requestId === 'string' ? requestId : '')
    if (!pending) return
    endRequest(pending, false, { ok: true, status: 'expired' })
    announceRequest(pending, 'cancelled')
  }

  function adoptReverseGrant(input: {
    grant: TailnetReverseGrant
    askerName: string
    peerNode: string | null
  }): MeshConnection | null {
    const { grant } = input
    // The same machine twice is two real records over there, exactly as a
    // second carried-code pairing is — but a reverse grant arrives without
    // anyone here pressing anything, so a duplicate for an endpoint already
    // paired replaces the old credential rather than stacking a row nobody
    // asked for. The old device over there is named in the log for revoking.
    const existing = store.list().find((entry) => entry.endpoint === grant.endpoint && entry.pairedVia === 'reverse')
    if (existing) {
      options.log?.(
        `Replacing the reverse pairing for ${grant.endpoint}: device "${existing.deviceName}" there is now unused; revoke it in that machine's Remote settings.`,
      )
      store.forget(existing.id)
    }
    let connection: MeshConnection
    try {
      connection = store.add({
        machineName: input.peerNode ?? grant.machineName ?? input.askerName,
        endpoint: grant.endpoint,
        deviceId: grant.deviceId,
        deviceName: grant.deviceName,
        deviceToken: grant.deviceToken,
        scopes: grant.scopes,
        pairedVia: 'reverse',
      })
    } catch (error) {
      options.log?.(`Could not keep the reverse pairing from ${input.askerName}: ${message(error)}`)
      return null
    }
    if (existing) {
      broadcast({ kind: 'machine-forgotten', connectionId: existing.id, machineName: existing.machineName })
    }
    broadcast({ kind: 'machine-paired', connection })
    syncReachabilityTimer()
    void probeReachability(connection)
    return connection
  }

  // ── Reachability (phase 4) ────────────────────────────────────────────────
  //
  // One small authenticated call per machine — the identity read, which is
  // also the one that tells "asleep" from "revoked over there" — on the
  // moments that change the answer: start, wake, the interval, a Retry. The
  // browse and the dial feed the same record, so a machine that just
  // answered a person is not shown as "not answering" until the next timer.
  const reachability = new Map<string, MeshMachineReachability>()
  const probes = new Map<string, Promise<void>>()
  let reachabilityTimer: ReturnType<typeof setInterval> | null = null
  /** `start` was called: the supervisor runs, and the change feed is watched. */
  let supervising = false

  function reachabilityFor(connection: MeshConnection): MeshMachineReachability {
    return (
      reachability.get(connection.id) ?? {
        connectionId: connection.id,
        machineName: connection.machineName,
        checking: false,
        reachable: false,
        unauthorized: false,
        checkedAt: null,
        lastReachedAt: connection.lastConnectedAt ? Date.parse(connection.lastConnectedAt) || null : null,
        detail: null,
      }
    )
  }

  function recordReachability(
    connection: MeshConnection,
    answer: { reachable: boolean; unauthorized: boolean; detail: string | null },
  ): void {
    const previous = reachabilityFor(connection)
    const now = Date.now()
    const next: MeshMachineReachability = {
      ...previous,
      machineName: connection.machineName,
      checking: false,
      reachable: answer.reachable,
      unauthorized: answer.unauthorized,
      checkedAt: now,
      lastReachedAt: answer.reachable ? now : previous.lastReachedAt,
      detail: answer.reachable ? null : answer.detail,
    }
    reachability.set(connection.id, next)
    broadcast({ kind: 'machine-reachability', ...next })
  }

  function probeReachability(connection: MeshConnection): Promise<void> {
    const inFlight = probes.get(connection.id)
    if (inFlight) return inFlight
    const checking: MeshMachineReachability = { ...reachabilityFor(connection), checking: true }
    reachability.set(connection.id, checking)
    broadcast({ kind: 'machine-reachability', ...checking })
    // Only this probe's own entry is cleared: a later check may already hold the slot.
    const settle = (): void => {
      if (probes.get(connection.id) === probe) probes.delete(connection.id)
    }
    const probe: Promise<void> = (async () => {
      const stored = store.find(connection.id)
      if (!stored) return
      const identity = await readRemoteIdentity({
        endpoint: endpointOf(stored),
        token: stored.deviceToken,
        timeoutMs: reachabilityTimeoutMs,
      })
      // Forgotten while the probe was out: nothing to record it against.
      if (!store.find(connection.id)) return
      if (identity.ok) {
        store.updateScopes(connection.id, identity.value.scopes)
        store.markConnected(connection.id)
        rememberIdentity(connection.id, identity.value)
        recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
        return
      }
      recordReachability(connection, {
        reachable: false,
        unauthorized: identity.code === 'unauthorized',
        detail: identity.message,
      })
    })().finally(settle)
    probes.set(connection.id, probe)
    return probe
  }

  async function checkAllReachability(): Promise<void> {
    await Promise.all(store.list().map((connection) => probeReachability(connection)))
  }

  /** What an identity answer says about the machine: which Studio it is. */
  function rememberIdentity(connectionId: string, identity: RemoteIdentity): void {
    if (identity.environmentId && store.noteEnvironment(connectionId, identity.environmentId))
      broadcast({ kind: 'machine-identified', connectionId, environmentId: identity.environmentId })
  }

  // ── The supervisor ────────────────────────────────────────────────────────

  /** The five-minute check runs only while there is a machine to check. */
  function syncReachabilityTimer(): void {
    const wanted = supervising && store.list().length > 0
    if (wanted && !reachabilityTimer) {
      reachabilityTimer = setInterval(() => {
        // Nobody is looking: a row nobody can see does not need to be right.
        if (!someoneLooking()) return
        void checkAllReachability()
      }, reachabilityIntervalMs)
      reachabilityTimer.unref?.()
    } else if (!wanted && reachabilityTimer) {
      clearInterval(reachabilityTimer)
      reachabilityTimer = null
    }
  }

  function start(): void {
    if (supervising) return
    supervising = true
    void checkAllReachability()
    syncReachabilityTimer()
  }

  function onWake(): void {
    void checkAllReachability()
  }

  async function readUsage(input: {
    connectionId: unknown
    args: Record<string, unknown>
    timeoutMs?: number
  }): Promise<MeshUsageResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, status: 'error', message: 'That machine is not paired here.' }
    const identity = await readRemoteIdentity({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      timeoutMs: USAGE_IDENTITY_TIMEOUT_MS,
    })
    if (!identity.ok) {
      const unauthorized = identity.code === 'unauthorized'
      recordReachability(connection, { reachable: false, unauthorized, detail: identity.message })
      if (unauthorized) return { ok: false, status: 'unauthorized', message: identity.message }
      // A machine on a wire this build does not speak is one to update, not one that is away.
      if (identity.code === 'unsupported_transport_version')
        return { ok: false, status: 'unsupported', message: identity.message }
      return { ok: false, status: 'offline', message: identity.message }
    }
    store.updateScopes(connection.id, identity.value.scopes)
    store.markConnected(connection.id)
    rememberIdentity(connection.id, identity.value)
    recordReachability(connection, { reachable: true, unauthorized: false, detail: null })
    if (!tailnetScopeGrantsAccess(new Set(identity.value.scopes), 'workspace:read'))
      return {
        ok: false,
        status: 'unauthorized',
        message: `This pairing may not read ${connection.machineName}'s workspaces, and so not its usage.`,
      }
    const args = input.args as UsageWireArgs
    try {
      const value = await peerStudios.ask(
        peerTarget(connection),
        (client) => client.rpc['usage.rows'](args),
        input.timeoutMs,
      )
      return { ok: true, value: value as unknown as Record<string, unknown> }
    } catch (error) {
      const refused = peerRefusal(connection, error)
      // A machine from before the protocol, or without the method: one to update.
      if (refused.kind === 'outdated')
        return {
          ok: false,
          status: 'unsupported',
          message: `Update Studio on ${connection.machineName} to include its usage.`,
        }
      if (refused.kind === 'unauthorized') return { ok: false, status: 'unauthorized', message: refused.message }
      if (refused.kind === 'unavailable') return { ok: false, status: 'offline', message: refused.message }
      return { ok: false, status: 'error', message: refused.message }
    }
  }

  // ── A window's own connection to a paired machine's Studio ──────────────
  //
  // The window asks that machine's Studio itself (design-lane-on-protocol D1);
  // what it needs from here is a ticket for each connection, bought with the
  // device token kept here, good once and from its origin alone.
  async function windowTicket(connectionId: unknown, origin: string): Promise<EnvironmentTicketResult> {
    const connection = connectionFor(connectionId)
    if (!connection) return { ok: false, code: 'unknown_route', message: 'That machine is not paired here.' }
    try {
      return { ok: true, ...(await peerStudioTicket(peerTarget(connection), origin)) }
    } catch (error) {
      const refused = peerRefusal(connection, error)
      // A pairing that machine no longer knows is one this machine shows as
      // signed out, as any other read that heard it would.
      if (refused.kind === 'unauthorized')
        recordReachability(connection, { reachable: false, unauthorized: true, detail: refused.message })
      return { ok: false, code: refused.code, message: refused.message }
    }
  }

  function getLiveState(): MeshLiveState {
    return {
      revision,
      requests: [...outboundRequests.values()].map((request) => ({ ...request.view })),
      reachability: [...reachability.values()].map((entry) => ({ ...entry })),
    }
  }

  /**
   * Drop this machine's credential for one peer, and everything hanging off it.
   *
   * Shared by `forget` and the outbound half of `forgetMachine` so the two can
   * never diverge on what forgetting entails: the reachability record, this
   * Studio's own client of it, the stored token, and the broadcast that tells
   * every window.
   */
  function forgetConnection(connectionId: string): { id: string; machineName: string } | null {
    const forgotten = store.find(connectionId)
    reachability.delete(connectionId)
    peerStudios.forget(connectionId)
    store.forget(connectionId)
    syncReachabilityTimer()
    if (forgotten) broadcast({ kind: 'machine-forgotten', connectionId, machineName: forgotten.machineName })
    // Never the stored record itself: it carries the device token, and nothing
    // above this line is allowed to hold one.
    return forgotten ? { id: forgotten.id, machineName: forgotten.machineName } : null
  }

  // This Studio's client of each paired machine's Studio, on its
  // `/tailnet/v1/studio` (tailnet-peer-studio.ts).
  const peerStudios = createPeerStudios()
  const peerTarget = (connection: StoredMeshConnection): PeerStudioTarget => ({
    id: connection.id,
    endpoint: endpointOf(connection),
    deviceToken: connection.deviceToken,
    machineName: connection.machineName,
  })

  return {
    start,
    onWake,
    async checkReachability(connectionId): Promise<MeshLiveState> {
      if (typeof connectionId === 'string') {
        const connection = store.find(connectionId)
        if (connection) await probeReachability(connection)
      } else await checkAllReachability()
      return getLiveState()
    },
    listConnections: () => store.list(),
    pair,
    requestPairing,
    collectPairing,
    cancelPairing,
    adoptReverseGrant,
    forgetMachine(input): MeshForgetMachineResult {
      const deviceId = typeof input.deviceId === 'string' && input.deviceId ? input.deviceId : null
      const connectionId = typeof input.connectionId === 'string' && input.connectionId ? input.connectionId : null
      // Inbound first. The outbound forget below tears down followed
      // conversations, and doing it in this order means a machine cannot slip a
      // request in through the door we are about to stop watching.
      let revokedDeviceId: string | null = null
      if (deviceId) {
        try {
          revokedDeviceId = options.revokeInboundDevice?.(deviceId) === true ? deviceId : null
        } catch (error) {
          // The outbound half is still worth ending: half a pairing removed is
          // better than none, and the caller sees which half by the nulls.
          options.log?.(`Could not revoke device ${deviceId}: ${message(error)}`)
        }
      }
      const forgotten = connectionId ? forgetConnection(connectionId) : null
      return {
        connections: store.list(),
        revokedDeviceId,
        forgottenConnectionId: forgotten ? forgotten.id : null,
      }
    },

    forget(connectionId): MeshConnection[] {
      if (typeof connectionId === 'string') forgetConnection(connectionId)
      return store.list()
    },
    windowTicket,
    readUsage,
    getLiveState,

    shutdown(): void {
      peerStudios.closeAll()
      supervising = false
      if (reachabilityTimer) clearInterval(reachabilityTimer)
      reachabilityTimer = null
      for (const request of [...outboundRequests.values()]) {
        // The process is going; the far end's copy lapses on its own. The
        // reverse device stays revocable by name, so it is left alone.
        if (request.timer) clearTimeout(request.timer)
        request.timer = null
      }
      outboundRequests.clear()
    },
  }
}

/**
 * The name an image goes up under. The upload route takes none without one,
 * and an image pasted from the clipboard has none of its own, so it is named
 * by its place in the message and its type.
 */
function endpointOf(connection: StoredMeshConnection): { host: string; port: number } {
  const parsed = parseTailnetEndpoint(connection.endpoint)
  // Unreadable endpoints never reach the store (the reader drops them), so this
  // is the type system's ask rather than a real branch.
  return parsed ?? { host: connection.endpoint, port: 0 }
}

function defaultDeviceName(): string {
  try {
    return hostname().trim()
  } catch {
    return ''
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
