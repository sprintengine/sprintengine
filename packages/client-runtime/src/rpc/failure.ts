import { STUDIO_PROTOCOL_WINDOW, studioIncompatibility } from '../protocol.js'
import { StudioError } from './errors.js'

/**
 * What a failed ask of Studio means to someone using a client:
 *
 *   - `client-outdated`: this app is behind the Studio's protocol; update this app.
 *   - `server-outdated`: the Studio is behind this app, or older than what was
 *     asked of it (a method or capability it does not serve); update the Studio.
 *   - `incompatible`: the two do not speak a protocol version in common, and
 *     the Studio did not say its own (one from before it did).
 *   - `unauthorized`: the credential or the pairing is refused.
 *   - `forbidden`: the pairing stands, but its grant does not reach this.
 *   - `connection`: the connection dropped, is away, or is busy; connecting
 *     again, or asking again later, can help.
 *   - `refused`: the request itself was refused (Studio's `unavailable`
 *     among them); the Studio's words say why.
 *
 * The first three are final: asking again cannot help until one side updates.
 */
export type StudioFailureKind =
  'client-outdated' | 'server-outdated' | 'incompatible' | 'unauthorized' | 'forbidden' | 'connection' | 'refused'

export type StudioFailure = { kind: StudioFailureKind; message: string }

/** Whether a failure's kind is a version mismatch: final until one side updates. */
export function isStudioVersionFailure(kind: StudioFailureKind): boolean {
  return kind === 'client-outdated' || kind === 'server-outdated' || kind === 'incompatible'
}

// Studio's own `unavailable` (it could not carry a request out) is a refusal
// of the request, not of the connection: a caller whose transport also says
// it for a machine away reads that itself.
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'offline',
  'timeout',
  'disconnected',
  'closed',
  'hello_timeout',
  'shutting_down',
  'resync_required',
  'too_many_connections',
  'internal_error',
  'environment_changed',
  'busy',
])

// Words for a Studio older than what was asked of it, for a caller that cannot name it.
const STUDIO_OLDER_THAN_APP = 'This Studio is older than this app and does not serve this. Update the Studio.'
const NO_COMMON_VERSION =
  'This app and this Studio do not speak a Studio protocol version in common. Update whichever is older.'

/**
 * A failed ask, read once for every client: which kind of failure it is, and
 * words a person can act on. A version refusal names the side to update in
 * the words a Studio's `incompatible` frame uses (`studioIncompatibility`),
 * judged from the Studio's window against this client's, never from the
 * refusal's own words, which were written from whichever end refused.
 */
export function presentStudioFailure(error: unknown): StudioFailure {
  if (!(error instanceof StudioError))
    return {
      kind: 'connection',
      message: error instanceof Error && error.message ? error.message : 'Studio could not answer.',
    }
  const message = error.message || 'Studio could not answer.'
  switch (error.code) {
    case 'unsupported_protocol_version': {
      const judged = error.studio ? studioIncompatibility(error.studio, STUDIO_PROTOCOL_WINDOW) : null
      return judged
        ? { kind: judged.compatibility, message: judged.message }
        : { kind: 'incompatible', message: NO_COMMON_VERSION }
    }
    case 'outdated':
    case 'unknown_method':
      return {
        kind: 'server-outdated',
        message: error.code === 'outdated' && error.message ? message : STUDIO_OLDER_THAN_APP,
      }
    case 'unauthorized':
    case 'revoked':
    case 'peer_mismatch':
      return { kind: 'unauthorized', message }
    case 'scope_required':
    case 'owner_required':
      return { kind: 'forbidden', message }
    default:
      return { kind: CONNECTION_CODES.has(error.code) ? 'connection' : 'refused', message }
  }
}
