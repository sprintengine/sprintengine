// Tailnet remote control: contracts shared between the main-process listener
// (src/main/automation/tailnet/) and the surfaces that configure it.
//
// The listener itself is opt-in and bound to the Tailscale interface address
// only.

import {
  studioPrincipal,
  type StudioPermission,
  type StudioPrincipal,
} from '../../packages/studio-protocol/src/permissions'
import { STUDIO_SCOPES, type StudioScope } from '../../packages/studio-protocol/src/scopes'
import {
  TAILNET_SCOPES,
  type TailnetScope,
  type TailnetPairRequestPhase,
} from '../../packages/studio-protocol/src/tailnet-types'
// The wire shapes, defined once in the protocol package.
export { TAILNET_SCOPES } from '../../packages/studio-protocol/src/tailnet-types'
export type {
  TailnetScope,
  TailnetDeviceOrigin,
  TailnetDevice,
  TailnetPairingState,
  TailnetRemoteStatus,
  TailnetMcpAccess,
  TailnetHttpsState,
  TailnetPairingOfferView,
  TailnetPairRequest,
  TailnetOAuthRequestView,
  TailnetApprovePairRequestView,
  TailnetLiveDevice,
  TailnetLiveState,
  TailnetPairRequestPhase,
  TailnetLiveEvent,
  TailnetPushPayload,
} from '../../packages/studio-protocol/src/tailnet-types'

/** Missing scope lists in older pairing requests must not grant features added later. */
export const TAILNET_LEGACY_REQUEST_SCOPES: readonly TailnetScope[] = [
  'workspace:read',
  'workspace:operate',
  'backlog:read',
  'backlog:operate',
]

export function isTailnetScope(value: unknown): value is TailnetScope {
  return typeof value === 'string' && (TAILNET_SCOPES as readonly string[]).includes(value)
}

export function normalizeTailnetScopes(value: unknown): TailnetScope[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<TailnetScope>()
  // Anything outside the vocabulary is dropped rather than rejected, which is
  // also how a device paired against a retired tool family loads: it keeps every
  // scope that still means something and silently loses the ones that do not.
  for (const entry of value) if (isTailnetScope(entry)) unique.add(entry)
  // Stable vocabulary order, so a stored device and a freshly minted one compare equal.
  return TAILNET_SCOPES.filter((scope) => unique.has(scope))
}

/**
 * Whether a set of granted scopes satisfies a required one.
 *
 * `operate` implies `read` within its family: a device trusted to change a
 * backlog item is necessarily trusted to see it, and granting them separately
 * would only produce devices that mutate blind. The implication is one-way — no
 * amount of read access ever confers operate — and never crosses families.
 */
export function tailnetScopeGrantsAccess(granted: ReadonlySet<TailnetScope>, required: TailnetScope): boolean {
  if (granted.has(required)) return true
  if (!required.endsWith(':read')) return false
  return granted.has(`${required.slice(0, -':read'.length)}:operate` as TailnetScope)
}

/**
 * What each scope a paired device holds carries, in the permissions every
 * remote method declares (`packages/studio-protocol/src/permissions.ts`).
 *
 * The scopes stay what is stored, paired and shown: a device file written by
 * any build reads the same, and another desktop or a phone is told the scopes
 * it always was. They are translated here, at the request, and nowhere else.
 * `operate` carries `read` within its family, the implication
 * `tailnetScopeGrantsAccess` draws, spelled out; no scope carries a terminal,
 * the filesystem, settings, or this machine's upkeep.
 */
export const TAILNET_SCOPE_PERMISSIONS: { readonly [S in TailnetScope]: readonly StudioPermission[] } = {
  'workspace:read': ['workspace:read'],
  'workspace:operate': ['workspace:read', 'workspace:operate'],
  'backlog:read': ['backlog:read'],
  'backlog:operate': ['backlog:read', 'backlog:operate'],
  'conversation:read': ['conversation:read'],
  'conversation:operate': ['conversation:read', 'conversation:operate'],
}

/**
 * The principal a paired device is, from its scopes as they stand now. Never
 * an owner: a device is a guest of this machine, whatever it was granted.
 * Names outside the vocabulary (a retired terminal scope) carry nothing.
 */
export function tailnetDevicePrincipal(scopes: readonly unknown[]): StudioPrincipal {
  return studioPrincipal({
    owner: false,
    permissions: normalizeTailnetScopes(scopes).flatMap((scope) => TAILNET_SCOPE_PERMISSIONS[scope]),
  })
}

/**
 * The Studio scopes a paired device holds on `/tailnet/v1/studio`, from the
 * scopes it was paired with, read as they stand at each request.
 *
 * - `conversation:operate` carries starting a chat as well as driving one:
 *   the gateway's `conversation.create` tool has always been an operate call
 *   for a device, and the protocol names it `conversation:create`.
 * - Either `workspace` scope carries the workspace reads (`workspaces:read`):
 *   the list, the CLIs a chat may run, a checkout, a project's skills, and
 *   the scheduled agents and the usage rows another desktop's dashboard reads.
 * - `workspace:operate` also carries `workspaces:operate`: making, changing,
 *   running, pausing and closing the scheduled agents, and reading a pull
 *   request in full.
 * - The backlog scopes carry their own: the backlogs read, and their items
 *   changed.
 *
 * No scope carries a terminal, the filesystem, settings, tools, modules or
 * this machine's upkeep, and the grant is never an owner's.
 */
export const TAILNET_SCOPE_STUDIO_SCOPES: { readonly [S in TailnetScope]: readonly StudioScope[] } = {
  'workspace:read': ['workspaces:read'],
  'workspace:operate': ['workspaces:read', 'workspaces:operate'],
  'backlog:read': ['backlog:read'],
  'backlog:operate': ['backlog:read', 'backlog:operate'],
  'conversation:read': ['conversation:read'],
  'conversation:operate': ['conversation:read', 'conversation:operate', 'conversation:create'],
}

/** A paired device's Studio scopes, deduplicated in the protocol's own order. */
export function tailnetDeviceStudioScopes(scopes: readonly unknown[]): StudioScope[] {
  const held = new Set(normalizeTailnetScopes(scopes).flatMap((scope) => TAILNET_SCOPE_STUDIO_SCOPES[scope]))
  return STUDIO_SCOPES.filter((scope) => held.has(scope))
}

/** What a requesting client learns when it polls its own request. */
export type TailnetPairRequestOutcome =
  | { status: 'pending'; comparisonCode: string; expiresAt: string }
  | {
      status: 'approved'
      deviceId: string
      deviceName: string
      /** Returned exactly once, to the poll that collects it. */
      deviceToken: string
      scopes: TailnetScope[]
    }
  // Denied and expired are distinct because the client should say different
  // things: one is an answer, the other is nobody having answered. An UNKNOWN
  // id also reports expired — there is nothing useful in telling a caller that
  // an id it invented never existed.
  | { status: 'denied' }
  | { status: 'expired' }

/**
 * How many wrong codes an approver may type before the request is declined
 * for them. Three is a typo allowance, not a guessing budget: the code is on
 * the asker's screen, and a person who cannot see it should not be approving.
 */
export const PAIR_REQUEST_CODE_ATTEMPTS = 3

/**
 * The reverse half of a both-ways pairing (phase 6): what the ASKING machine
 * sends with its final collect so the machine that approved it can drive it
 * back. The asker minted this device for the approver on its own store; the
 * token travels exactly once, inside the collect that also takes the
 * approver's token, and only over the request the approver already said yes
 * to. Absent when the asker has no listener (a phone) or did not offer it.
 */
export type TailnetReverseGrant = {
  /** `address:port` of the asker's listener, for the approver to dial. */
  endpoint: string
  /** The asker's name for itself, as the approver's Mesh will list it. */
  machineName: string
  deviceId: string
  /** The name the approver's machine was granted under on the asker. */
  deviceName: string
  deviceToken: string
  scopes: TailnetScope[]
}

/** Main → window, the shell's own: open the Remote popover (an OS notification was clicked). */
export const REMOTE_OPEN_REQUESTED_CHANNEL = 'remote:open-requested'

// ── Live state, pushed ──────────────────────────────────────────────────────
//
// The listener pushes a `TailnetPushPayload` to every follower of
// `tailnet.changed` whenever it, a pairing request, or a device's live
// connection changes, so a window never polls. The payload always carries a
// fresh status and live snapshot beside the event that caused it, so a
// consumer stores the latest and cannot drift by missing one event.

/** Every phase after `received`: the request no longer exists to be answered. */
export function isPairRequestTerminalPhase(phase: TailnetPairRequestPhase): boolean {
  return phase !== 'received'
}
