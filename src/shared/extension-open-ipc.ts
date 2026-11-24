// The window half of `extension.open` (extension-open.ts), as main and a
// workspace window speak it: main asks one window at a time
// (src/main/extension-open-broker.ts) and the window answers with what it did
// (useExtensionOpenRequests). Each ask carries an id of its own, so an answer
// that arrives after main moved on to the next window is not mistaken for that
// window's.
//
// Pure and Node-free: main, the server, the preload and the renderer all read it.

import type { ExtensionOpenOutcome, ExtensionOpenRefusal, ExtensionOpenRequest } from './extension-open'

export const EXTENSION_OPEN_REQUEST_CHANNEL = 'extension-open:request'
export const EXTENSION_OPEN_ACK_CHANNEL = 'extension-open:ack'

/** One ask of one window. */
export type ExtensionOpenWindowRequest = ExtensionOpenRequest & { requestId: string }

/** A window's answer to one ask. */
export type ExtensionOpenAck = { requestId: string; outcome: ExtensionOpenOutcome }

const REFUSALS: ReadonlySet<ExtensionOpenRefusal> = new Set(['no_window', 'no_workspace', 'not_found'])

/** An outcome as it arrives from another process or window, or null when it is not one. */
export function readExtensionOpenOutcome(value: unknown): ExtensionOpenOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { ok, workspaceId, code, message } = value as Record<string, unknown>
  if (ok === true) {
    return typeof workspaceId === 'string' && workspaceId.length > 0 && workspaceId.length <= 200
      ? { ok: true, workspaceId }
      : null
  }
  if (ok !== false || typeof code !== 'string' || !REFUSALS.has(code as ExtensionOpenRefusal)) return null
  // A window's own words, kept short: they end up in an agent's tool result.
  const said = typeof message === 'string' ? message.slice(0, 500) : ''
  return { ok: false, code: code as ExtensionOpenRefusal, message: said }
}

/** A window's answer as main hears it, or null when it is not one. */
export function readExtensionOpenAck(payload: unknown): ExtensionOpenAck | null {
  if (!payload || typeof payload !== 'object') return null
  const { requestId, outcome } = payload as Record<string, unknown>
  if (typeof requestId !== 'string' || !requestId) return null
  const read = readExtensionOpenOutcome(outcome)
  return read ? { requestId, outcome: read } : null
}
