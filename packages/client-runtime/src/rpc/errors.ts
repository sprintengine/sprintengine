import type { StudioByeFrame, StudioProtocolWindow } from '../protocol.js'

/** The Studio a version refusal was about: its protocol window, and its version once it has said it. */
export type StudioErrorStudio = StudioProtocolWindow & { version?: string }

/**
 * A refusal from Studio, or the client's own: `code` is the protocol's word for
 * it (`scope_required`, `ceiling_exceeded`, `unauthorized`, …), `retryAfterMs`
 * how long to wait when waiting can help.
 */
export class StudioError extends Error {
  readonly code: string
  readonly retryAfterMs?: number
  /** The id Studio logged the real cause under, when it answered in stable words instead. */
  readonly errorId?: string
  /**
   * On an `unsupported_protocol_version`, the Studio's window when it said it:
   * what tells which side is behind (`presentStudioFailure`).
   */
  readonly studio?: StudioErrorStudio

  constructor(code: string, message: string, retryAfterMs?: number, errorId?: string, studio?: StudioErrorStudio) {
    super(message)
    this.name = 'StudioError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
    if (errorId !== undefined) this.errorId = errorId
    if (studio !== undefined) this.studio = studio
  }
}

/** Why a connection closed for good: reconnecting cannot help until the credential or a version changes. */
export const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'revoked',
  'unsupported_protocol_version',
  'hello_required',
  'invalid_frame',
  // A pairing's token could not be kept; connecting again needs that fixed first.
  'token_not_kept',
  // The connection reached a different Studio from the one this client follows.
  'environment_changed',
])

/**
 * Whether a refusal ends the client for good. A `hello_required` that names a
 * delay is a hello that arrived too late (a busy machine, a sleep between
 * connecting and saying it), which connecting again can fix.
 */
export function isTerminalStudioCode(code: string, retryAfterMs?: number): boolean {
  if (code === 'hello_required' && retryAfterMs !== undefined) return false
  return TERMINAL_CODES.has(code)
}

/** A `bye`, as the error it closes the client with: the Studio's window kept when it named one. */
export function byeError(frame: StudioByeFrame): StudioError {
  const studio =
    frame.protocolVersion !== undefined && frame.minProtocolVersion !== undefined
      ? { protocolVersion: frame.protocolVersion, minProtocolVersion: frame.minProtocolVersion }
      : undefined
  return new StudioError(frame.code, frame.message, frame.retryAfterMs, undefined, studio)
}
