import { isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'

// The tailnet listener's route table, in its own module so both the gateway
// server and the remote client can name a path without importing each other.

const TAILNET_ROUTE_PREFIX = '/tailnet/v1'
export const TAILNET_HEALTH_PATH = `${TAILNET_ROUTE_PREFIX}/health`
export const TAILNET_PAIR_PATH = `${TAILNET_ROUTE_PREFIX}/pair`
/**
 * Pairing by approval on the machine being driven: POST asks, GET
 * polls the answer. Unauthenticated like `pair`, because a peer that has not
 * been approved yet has no credential by definition.
 */
export const TAILNET_PAIR_REQUEST_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request`
/**
 * The collect as a POST (pair-from-the-scan-and-stay-paired, phase 6): the
 * same poll `GET pair-request` answers, but with a body, so an approved
 * collect can carry the asker's reverse grant — a device it minted for this
 * machine — in the one exchange the approver already said yes to. GET stays
 * for clients that never offer one.
 */
export const TAILNET_PAIR_COLLECT_PATH = `${TAILNET_ROUTE_PREFIX}/pair-request/collect`
export const TAILNET_IDENTITY_PATH = `${TAILNET_ROUTE_PREFIX}/identity`
export const TAILNET_MCP_PATH = `${TAILNET_ROUTE_PREFIX}/mcp`
export const TAILNET_WS_TICKET_PATH = `${TAILNET_ROUTE_PREFIX}/ws-ticket`
export const TAILNET_STREAM_PATH = `${TAILNET_ROUTE_PREFIX}/stream`
/**
 * The Studio protocol, for a paired device: the one contract every client
 * speaks (`packages/studio-protocol`), over a WebSocket opened with a ticket
 * from `ws-ticket`, attached to the same Studio server this machine's own
 * windows use. What a device may ask is its grant, read again at every
 * request. A desktop window's socket names its origin when it asks for the
 * ticket and carries exactly that origin; every other socket carries none.
 */
export const TAILNET_STUDIO_PATH = `${TAILNET_ROUTE_PREFIX}/studio`
/**
 * The Studio protocol of a machine this desktop holds (a WSL distribution's
 * or an SSH machine's server), for a paired device: `<prefix><environmentId>/studio`.
 * The device proves itself here as on `TAILNET_STUDIO_PATH`, with a ticket
 * from `ws-ticket` that names the environment, and this desktop carries the
 * socket to that machine's own listener, which admits it with the device's
 * grant cut to what a relayed device may hold, never an owner's.
 */
const TAILNET_ENVIRONMENTS_PREFIX = `${TAILNET_ROUTE_PREFIX}/environments/`

/** The path a paired device opens to reach a machine this desktop relays. */
export function tailnetEnvironmentStudioPath(environmentId: string): string {
  return `${TAILNET_ENVIRONMENTS_PREFIX}${environmentId}/studio`
}

/** The environment a relayed Studio path names, or null for any other path. */
export function tailnetRelayedEnvironmentOf(path: string): string | null {
  if (!path.startsWith(TAILNET_ENVIRONMENTS_PREFIX) || !path.endsWith('/studio')) return null
  const id = path.slice(TAILNET_ENVIRONMENTS_PREFIX.length, -'/studio'.length)
  return isEnvironmentId(id) ? id : null
}

// OAuth for the MCP endpoint (`tailnet-oauth-http.ts`). Unauthenticated, as
// pairing is: they are how a client without a credential gets one. The
// well-known documents that name them sit at the root, where RFC 8414 and
// RFC 9728 put them.
const TAILNET_OAUTH_PREFIX = `${TAILNET_ROUTE_PREFIX}/oauth`
export const TAILNET_OAUTH_REGISTER_PATH = `${TAILNET_OAUTH_PREFIX}/register`
export const TAILNET_OAUTH_AUTHORIZE_PATH = `${TAILNET_OAUTH_PREFIX}/authorize`
export const TAILNET_OAUTH_WAIT_PATH = `${TAILNET_OAUTH_PREFIX}/authorize/wait`
export const TAILNET_OAUTH_TOKEN_PATH = `${TAILNET_OAUTH_PREFIX}/token`
export const TAILNET_OAUTH_REVOKE_PATH = `${TAILNET_OAUTH_PREFIX}/revoke`

// ── What this transport speaks ───────────────────────────────────────────────
//
// Here rather than in the gateway server for the same reason the paths are:
// the version is the wire's own fact, and a client (the phone) reads it from
// `health` before it has any other opinion about this machine. What a device
// may do on this machine comes from the Studio protocol's welcome, not from
// here.

/**
 * Bumped when the wire changes in a way a client must know about.
 * 2 (2026-09-06): the change feed, sliced replay frames, git only for running sessions.
 * 3 (2026-11-14): the conversation lane, the change feed and the canvas lane are gone; a paired
 * device speaks the Studio protocol at `TAILNET_STUDIO_PATH`.
 */
export const TAILNET_TRANSPORT_VERSION = 3

/**
 * The oldest wire this build will still drive: none older. Version 3 took
 * away every route an older client used for its chats, so a build on 2 or
 * below has nothing it can do here, and is told to update (its own reading
 * of `health` says so; a retired route answers `426`). Skew between current
 * builds is met inside the Studio protocol's handshake, not by a window here.
 */
export const TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION = 3

/**
 * The routes version 3 took away. A client that still asks for one is a build
 * from before it, and is answered `426 client_update_required` with
 * `TAILNET_CLIENT_UPDATE_MESSAGE`, never a bare not-found.
 */
export const TAILNET_RETIRED_PATHS: ReadonlySet<string> = new Set(
  [
    'conversation',
    'events',
    'canvas',
    'upload',
    'conversation-image',
    'conversation-files',
    'conversation-commands',
  ].map((name) => `${TAILNET_ROUTE_PREFIX}/${name}`),
)

/** What a build from before version 3 is told when it asks for a route that went. */
export const TAILNET_CLIENT_UPDATE_MESSAGE =
  'This Studio serves paired apps on the Studio protocol now. Update the app on this device to reach it.'

/** A handshake refused for speaking a wire this build does not. */
export type TailnetTransportRefusal = {
  code: 'unsupported_transport_version'
  message: string
}

/** The versions this build speaks, as a range (`2–3`) or one (`3`). */
function supportedTransportVersions(): string {
  return [...new Set<number>([TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION, TAILNET_TRANSPORT_VERSION])].join('–')
}

/**
 * Check a peer's advertised transport version, returning null when it is one we
 * speak and a refusal when it is not.
 *
 * The whole point is that this fires at the handshake. Until it did, a peer on
 * an incompatible wire was accepted and then failed somewhere downstream on a
 * payload shape — a tool answering in a form this build could not read, a frame
 * with a field that moved — which is the expensive kind of failure: it surfaces
 * far from its cause and reads as a bug in whatever tool happened to be called.
 *
 * The refusal names both versions because that is the whole diagnosis. "Cannot
 * connect" sends someone to the network; "that machine speaks 4, this one
 * speaks 1–2" tells them which of the two installs to update.
 */
export function checkTailnetTransportVersion(seen: unknown): TailnetTransportRefusal | null {
  if (
    Number.isInteger(seen) &&
    (seen as number) >= TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION &&
    (seen as number) <= TAILNET_TRANSPORT_VERSION
  ) {
    return null
  }
  // A peer that states nothing readable gets its own sentence: "speaks version
  // undefined" would read as a bug here rather than as a fact about that machine.
  const seenClause = Number.isInteger(seen)
    ? `That machine speaks transport version ${seen as number}`
    : 'That machine did not state a transport version this build could read'
  return {
    code: 'unsupported_transport_version',
    message: `${seenClause}; this build speaks ${supportedTransportVersions()}. Update whichever of the two is older.`,
  }
}
