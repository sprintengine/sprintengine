import { studioParams, studioParamsRefused, type StudioMethodDefinition, type StudioMethodTable } from './contract.js'
import type { StudioEnvironment, StudioServerIdentity } from './envelope.js'
import {
  STUDIO_UPDATE_SESSION_CAPABILITY,
  studioCompatibility,
  type StudioCompatibility,
  type StudioProtocolWindow,
} from './handshake.js'

// Keeping a Studio up to date, and reaching one that is not.
//
// A client and a Studio talk when each serves the other's protocol version
// (`checkStudioProtocolVersion`). When they do not, the client still needs to
// learn who the Studio is, which side is out of date, and how to fix it: an
// independently running Studio (a paired desktop, a server inside WSL or on
// an SSH machine) can outlive several releases of the client that reaches it.
//
// So a client that lists `update-session` in its hello's capabilities is not
// simply closed. Once it has authenticated, it is sent an `incompatible` frame
// in place of the welcome, and its connection stays open for the update
// methods alone: `update.status` and `update.start`. Anything else it asks is
// refused `unsupported_protocol_version`.
//
// The `incompatible` frame, the two methods, their params and their results
// are the one part of the protocol that must never change shape, since they
// are what two ends that disagree on everything else still speak. Members may
// be added, optional; none is removed or retyped. `update.test.ts` pins them.

/**
 * Who can update a Studio:
 *
 *   - `self`: it updates itself (a desktop, through its app updater): a client
 *     holding `environment:maintain` asks with `update.start`.
 *   - `bootstrap`: the desktop that installed it (a server inside WSL or on an
 *     SSH machine) updates it when it next connects; `manual` names where.
 *   - `manual`: someone started it by hand; `manual` says what to do.
 *
 * A client reads a value it does not know as `manual`.
 */
export type StudioUpdateMethod = 'self' | 'bootstrap' | 'manual'

/**
 * Where an update stands. `available` names a version not yet downloaded,
 * `ready` one downloaded and waiting for a restart, `installing` one the
 * Studio is restarting into. A client reads a value it does not know as
 * `idle`.
 */
export type StudioUpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed'

/** What `update.status` answers. */
export type StudioUpdateStatus = {
  serverVersion: string
  protocolVersion: number
  minProtocolVersion: number
  method: StudioUpdateMethod
  state: StudioUpdateState
  /** The version an update would bring, when one is known. */
  available?: { version: string }
  /** The last update that did not happen: what it went to, and why, in words. Kept until one succeeds. */
  lastFailure?: { version?: string; message: string; at: number }
  /** What a person does to update it by hand, in words; always present for `bootstrap` and `manual`. */
  manual?: string
}

/**
 * Sent in place of `welcome` to an authenticated client that opted in and
 * whose protocol window does not meet this Studio's. The connection stays
 * open for `update.status` and `update.start`.
 */
export type StudioIncompatibleFrame = {
  t: 'incompatible'
  protocolVersion: number
  minProtocolVersion: number
  server: StudioServerIdentity
  environment: StudioIncompatibleEnvironment
  /** From the client's side: `client-outdated` or `server-outdated`. */
  compatibility: Exclude<StudioCompatibility, 'compatible' | 'unknown'>
  /** Why, naming both versions and which side to update. */
  message: string
  update: StudioUpdateStatus
}

/**
 * Which Studio sent an `incompatible` frame: the welcome's `environment`,
 * read so that a later Studio's is never lost. A host kind this client does
 * not know is `other`.
 */
export type StudioIncompatibleEnvironment = Omit<StudioEnvironment, 'hostKind'> & {
  hostKind: StudioEnvironment['hostKind'] | 'other'
}

/** The most characters of words an update status carries in one member; longer is cut, not refused. */
export const STUDIO_UPDATE_MAX_TEXT = 2_000
/** The most characters of a version a status or frame carries; longer is cut. */
export const STUDIO_UPDATE_MAX_VERSION = 64

export type StudioUpdateMethodMap = {
  /** Who this Studio is, how it is updated, and where an update stands. Any authenticated client. */
  'update.status': { params: Record<string, never>; result: StudioUpdateStatus }
  /**
   * Update a `self` Studio: check, download, then drain and restart into the
   * new version. Answered once accepted; the restart closes the connection,
   * and the client reads the outcome from the next welcome's version, or from
   * `update.status`'s `lastFailure`. Asked again while one runs, it is
   * accepted again. Refused `update_unavailable` for a `bootstrap` or
   * `manual` Studio, with the words to do it by hand.
   */
  'update.start': {
    params: { commandId: string; targetVersion?: string }
    result: { accepted: true; method: 'self'; targetVersion: string | null }
    errors: 'update_unavailable'
  }
}

export type StudioUpdateMethodName = keyof StudioUpdateMethodMap

/**
 * How a client stands with a Studio whose window does not meet its own, and
 * why, in words that name both versions and which side to update; null when
 * the two windows meet. What a Studio puts in the `incompatible` frame and in
 * its `unsupported_protocol_version` bye, and what a client shows for either.
 * Without the Studio's `version` (a bye, sent before the client has
 * authenticated) the words name the protocol numbers alone.
 */
export function studioIncompatibility(
  server: StudioProtocolWindow & { version?: string },
  client: StudioProtocolWindow,
): { compatibility: StudioIncompatibleFrame['compatibility']; message: string } | null {
  const compatibility = studioCompatibility(server, client)
  const studio = server.version ? `This Studio (${server.version})` : 'This Studio'
  if (compatibility === 'client-outdated')
    return {
      compatibility,
      message: `${studio} needs Studio protocol ${server.minProtocolVersion} or newer, and this app speaks ${client.protocolVersion}. Update this app.`,
    }
  if (compatibility === 'server-outdated')
    return {
      compatibility,
      message: `${studio} speaks Studio protocol ${server.protocolVersion}, and this app needs ${client.minProtocolVersion} or newer. Update the Studio.`,
    }
  return null
}

/** The methods an incompatible client's connection is served. */
export const STUDIO_UPDATE_SESSION_METHODS: readonly StudioUpdateMethodName[] = ['update.status', 'update.start']

// ── Validation ──────────────────────────────────────────────────────────────

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
// Lenient on purpose: these are read from a Studio of any later version, so a
// member out of today's bounds is cut to them, and one of the wrong type is
// dropped, rather than the whole status or frame refused.
function words(value: unknown, max = STUDIO_UPDATE_MAX_TEXT): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null
}
function appVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= STUDIO_UPDATE_MAX_VERSION
}

const METHODS: readonly StudioUpdateMethod[] = ['self', 'bootstrap', 'manual']
const STATES: readonly StudioUpdateState[] = [
  'idle',
  'checking',
  'available',
  'downloading',
  'ready',
  'installing',
  'failed',
]
const HOST_KINDS: readonly string[] = ['local', 'wsl', 'ssh', 'tailnet']

/**
 * An update status as a client reads it: unknown members dropped, a method or
 * state it does not know read as `manual` or `idle`, words and versions cut to
 * their bounds. Null when it is not one at all.
 */
export function parseStudioUpdateStatus(value: unknown): StudioUpdateStatus | null {
  if (!record(value)) return null
  const serverVersion = words(value.serverVersion, STUDIO_UPDATE_MAX_VERSION)
  if (!serverVersion || !version(value.protocolVersion) || !version(value.minProtocolVersion)) return null
  const method = METHODS.includes(value.method as StudioUpdateMethod) ? (value.method as StudioUpdateMethod) : 'manual'
  const state = STATES.includes(value.state as StudioUpdateState) ? (value.state as StudioUpdateState) : 'idle'
  const available = record(value.available) ? words(value.available.version, STUDIO_UPDATE_MAX_VERSION) : null
  const failure = record(value.lastFailure) ? value.lastFailure : null
  const failureWords = failure ? words(failure.message) : null
  const failureVersion = failure ? words(failure.version, STUDIO_UPDATE_MAX_VERSION) : null
  const failed =
    failure && failureWords && typeof failure.at === 'number' && Number.isFinite(failure.at)
      ? { ...(failureVersion ? { version: failureVersion } : {}), message: failureWords, at: failure.at }
      : null
  const manual = words(value.manual)
  return {
    serverVersion,
    protocolVersion: value.protocolVersion,
    minProtocolVersion: value.minProtocolVersion,
    method,
    state,
    ...(available ? { available: { version: available } } : {}),
    ...(failed ? { lastFailure: failed } : {}),
    ...(manual ? { manual } : {}),
  }
}

/**
 * An `incompatible` frame as a client reads it, as leniently as its status:
 * only what a client cannot do without (the versions, the environment's id,
 * the update status) is required. `compatibility` is the side behind this
 * client's own `client` window, judged from the versions; only where they
 * meet it (a frame sent to another client) does the Studio's word stand, and
 * a word this client does not know is read as its own to update.
 */
export function parseStudioIncompatibleFrame(
  value: unknown,
  client: StudioProtocolWindow,
): StudioIncompatibleFrame | null {
  if (!record(value) || value.t !== 'incompatible') return null
  if (!version(value.protocolVersion) || !version(value.minProtocolVersion)) return null
  const update = parseStudioUpdateStatus(value.update)
  const where = record(value.environment) ? value.environment : null
  const environmentId = where && typeof where.id === 'string' && /^.{1,200}$/su.test(where.id) ? where.id : null
  if (!update || !where || !environmentId) return null
  const server = record(value.server) ? value.server : {}
  const judged = studioCompatibility(
    { protocolVersion: value.protocolVersion, minProtocolVersion: value.minProtocolVersion },
    client,
  )
  return {
    t: 'incompatible',
    protocolVersion: value.protocolVersion,
    minProtocolVersion: value.minProtocolVersion,
    server: {
      name: words(server.name, 120) ?? 'SprintEngine Studio',
      version: words(server.version, STUDIO_UPDATE_MAX_VERSION) ?? update.serverVersion,
    },
    environment: {
      id: environmentId,
      hostKind: HOST_KINDS.includes(where.hostKind as string)
        ? (where.hostKind as StudioEnvironment['hostKind'])
        : 'other',
      os: words(where.os, 64) ?? '',
      arch: words(where.arch, 64) ?? '',
    },
    compatibility:
      judged === 'server-outdated' || judged === 'client-outdated'
        ? judged
        : value.compatibility === 'server-outdated'
          ? 'server-outdated'
          : 'client-outdated',
    message: words(value.message) ?? 'This app and this Studio do not speak a protocol version in common.',
    update,
  }
}

const start: StudioMethodDefinition<StudioUpdateMethodMap['update.start']> = {
  scope: 'environment:maintain',
  mutation: true,
  capability: STUDIO_UPDATE_SESSION_CAPABILITY,
  params: (value) => {
    if (!(typeof value.commandId === 'string' && value.commandId.length > 0 && value.commandId.length <= 200))
      return studioParamsRefused('"commandId" names this update request: 1 to 200 characters.')
    if (value.targetVersion !== undefined && !appVersion(value.targetVersion))
      return studioParamsRefused('"targetVersion" is a version of at most 64 characters.')
    return studioParams({
      commandId: value.commandId,
      ...(value.targetVersion === undefined ? {} : { targetVersion: value.targetVersion as string }),
    })
  },
}

export const STUDIO_UPDATE_METHODS: StudioMethodTable<StudioUpdateMethodMap> = {
  // No scope: any authenticated client may learn that it cannot talk to this
  // Studio and how that is fixed, whatever it was granted.
  'update.status': {
    scope: null,
    mutation: false,
    capability: STUDIO_UPDATE_SESSION_CAPABILITY,
    params: () => studioParams({}),
  },
  'update.start': start,
}
