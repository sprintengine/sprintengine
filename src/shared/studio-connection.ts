// How a Studio window reaches the Studio RPC: a WebSocket to its server's
// window listener on 127.0.0.1, like any other client of the protocol. The
// window asks main for a ticket before each connection, reconnects included;
// main asks the server, which mints one good for a single connection within
// thirty seconds, from that window's origin only. Nothing longer-lived ever
// reaches the page.

/** Ask main for a connection ticket: answered with a `StudioWindowTicket`. */
export const STUDIO_WINDOW_TICKET_CHANNEL = 'studio:window-ticket'

/**
 * Where a window's next connection goes and the credential its hello presents.
 * The URL names the ticket too, so the server can refuse a socket before it
 * is open; the token is that same ticket, spent by the hello.
 */
export type StudioWindowTicket = { url: string; token: string }

/** Which way the chat view reaches conversations in this window. */
export type StudioChatTransportMode = 'ipc' | 'studio'

/**
 * Set to `studio` to put the chat view on the Studio protocol, or `ipc` to
 * keep it on the conversation IPC. The IPC path is the default until the
 * protocol path has had its release beside it.
 */
export const STUDIO_CHAT_TRANSPORT_ENV = 'SPRINTENGINE_CHAT_TRANSPORT'

export function studioChatTransportMode(value: string | undefined): StudioChatTransportMode {
  return value?.trim().toLowerCase() === 'studio' ? 'studio' : 'ipc'
}

/**
 * The `Origin` a window's socket carries, from the address of the document
 * that asked for its ticket. A page loaded from a file says `file://`; any
 * other says its scheme, host and port.
 */
export function studioWindowOrigin(documentUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(documentUrl)
  } catch {
    return null
  }
  if (parsed.protocol === 'file:') return 'file://'
  return parsed.origin === 'null' ? null : parsed.origin
}
