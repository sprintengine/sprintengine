import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import type { StudioWindowTicket } from '../../shared/studio-connection'
import { acceptWebSocket, refuseUpgrade, webSocketKeyOf, webSocketStream } from '../web/web-socket'
import { createTicketAuthenticator, mintStudioTicket } from './studio-frame-port'
import type { StudioRpcConnection } from './studio-rpc-connection'
import type { StudioAuthenticator } from './studio-rpc-types'

// Studio's own windows reach their server here: a WebSocket on 127.0.0.1, the
// Studio protocol on `/ws` and nothing else. A loopback port is open to every
// process on the machine and every page a browser on it shows, so the socket
// rests on authentication, not on where it listens:
//
// - Each connection presents a ticket main asked for on behalf of one of its
//   windows: 32 random bytes, kept here only as a hash, good once, for thirty
//   seconds, and only from the origin of the document it was minted for.
//   The ticket rides the upgrade's query, so a socket without one is refused
//   before it opens, and the hello presents it again as its credential.
// - The `Host` must name 127.0.0.1 itself (no DNS rebinding), and the
//   `Origin` the window's (no page on another site, which a browser would
//   label with its own origin).
// - A window's connections end when main says the window has gone: closed,
//   crashed or navigated away. Nothing a window held survives it.
//
// The window holds nothing longer-lived than a ticket, so there is no token to
// renew: each reconnect asks main for a fresh one, and main asks the server it
// is talking to now, which is how a restarted server, on a new port, is found.

/** How long a ticket waits for its socket. */
export const WINDOW_TICKET_TTL_MS = 30_000
/** Outstanding tickets kept at once; past this the oldest go. */
const MAX_OUTSTANDING_TICKETS = 256
/** A window has one connection, and a few more while it reconnects or an aux view of it opens its own. */
const MAX_CONNECTIONS_PER_WINDOW = 4
/** The path the protocol is served on. */
const WINDOW_SOCKET_PATH = '/ws'

export type StudioWindowListenerOptions = {
  /** Serve a connection the listener admitted; its hello must present the given authenticator's ticket. */
  attach(stream: Duplex, authenticator: StudioAuthenticator): StudioRpcConnection
  now?: () => number
  log?: (line: string) => void
}

export type StudioWindowTicketRequest = {
  /** The window this connection is for, as main names it; revoked together. */
  windowKey: string
  /** The `Origin` the window's socket will carry. */
  origin: string
}

export type StudioWindowListener = {
  /** Mint a ticket for one connection of a window, listening first if this is the first. */
  ticket(request: StudioWindowTicketRequest): Promise<StudioWindowTicket>
  /** The window has gone: its outstanding tickets are void and its connections end. */
  revokeWindow(windowKey: string): void
  /** Where the listener is, once it is: `ws://127.0.0.1:<port>`. */
  address(): string | null
  stop(): Promise<void>
}

type Outstanding = { windowKey: string; origin: string; mintedAt: number }

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('base64url')
}

/** The host name a `Host` header names, without its port. */
function hostName(host: string | undefined): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/**
 * The socket comes from the document the ticket was minted for. A page loaded
 * from a file says `file://` (checked with this repository's Electron); `null`
 * is any opaque origin (a sandboxed frame, a `data:` page), so it is refused.
 */
function originMatches(presented: string | undefined, expected: string): boolean {
  return presented !== undefined && presented === expected
}

export function createStudioWindowListener(options: StudioWindowListenerOptions): StudioWindowListener {
  const now = options.now ?? Date.now
  const outstanding = new Map<string, Outstanding>()
  const connections = new Map<string, StudioRpcConnection[]>()
  let server: Server | null = null
  let port: number | null = null
  let listening: Promise<number> | null = null
  let stopped = false

  function prune(): void {
    const cutoff = now() - WINDOW_TICKET_TTL_MS
    for (const [hash, entry] of outstanding) if (entry.mintedAt < cutoff) outstanding.delete(hash)
    while (outstanding.size > MAX_OUTSTANDING_TICKETS) {
      const oldest = outstanding.keys().next().value
      if (oldest === undefined) break
      outstanding.delete(oldest)
    }
  }

  function admit(windowKey: string, connection: StudioRpcConnection): void {
    const held = (connections.get(windowKey) ?? []).filter((entry) => !entry.isClosed())
    held.push(connection)
    while (held.length > MAX_CONNECTIONS_PER_WINDOW) {
      held.shift()?.bye('revoked', 'This window opened a newer connection to Studio.')
    }
    connections.set(windowKey, held)
  }

  /** Refuse an upgrade, and say why in the log: the code, never the ticket. */
  function refuse(socket: Duplex, status: number, code: string): void {
    options.log?.(`window listener refused a socket: ${code}`)
    refuseUpgrade(socket, status, code)
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'ws://127.0.0.1')
    if (url.pathname !== WINDOW_SOCKET_PATH) return refuse(socket, 404, 'not_found')
    // Named by its address, never by a name: a page whose own host name a DNS
    // server rebinds to 127.0.0.1 still says that name here.
    if (hostName(request.headers.host) !== '127.0.0.1') return refuse(socket, 403, 'wrong_host')
    const key = webSocketKeyOf(request)
    if (!key.ok) return refuse(socket, 400, key.code)
    const ticket = url.searchParams.get('ticket')
    if (!ticket) return refuse(socket, 401, 'ticket_required')
    prune()
    const hash = hashTicket(ticket)
    const entry = outstanding.get(hash)
    // Spent by being presented, whatever happens next.
    outstanding.delete(hash)
    if (!entry) return refuse(socket, 401, 'ticket_spent_or_expired')
    if (!originMatches(request.headers.origin, entry.origin)) {
      options.log?.(`window listener expected origin ${entry.origin}, heard ${request.headers.origin ?? 'none'}`)
      return refuse(socket, 403, 'origin_refused')
    }
    const peer = acceptWebSocket(socket, key.key, head)
    const connection = options.attach(webSocketStream(peer), createTicketAuthenticator(ticket, { now }))
    if (!connection.isClosed()) admit(entry.windowKey, connection)
  }

  function listen(): Promise<number> {
    listening ??= new Promise<number>((resolve, reject) => {
      const next = createServer((_request, response) => {
        response.writeHead(404, { 'Content-Length': '0', Connection: 'close' })
        response.end()
      })
      next.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        try {
          handleUpgrade(request, socket, head)
        } catch (error) {
          options.log?.(`window listener upgrade: ${error instanceof Error ? error.message : String(error)}`)
          refuseUpgrade(socket, 400, 'bad_request')
        }
      })
      next.once('error', (error) => {
        listening = null
        reject(error)
      })
      next.listen(0, '127.0.0.1', () => {
        server = next
        port = (next.address() as AddressInfo).port
        options.log?.(`window listener on 127.0.0.1:${port}`)
        resolve(port)
      })
    })
    return listening
  }

  return {
    async ticket(request) {
      // A server on its way out mints nothing: the window asks again, and finds its successor.
      if (stopped) throw new Error('Studio is closing, so this window cannot connect to it now.')
      const listeningOn = await listen()
      // Stopped while it started listening: no ticket for a listener that is gone.
      if (stopped) throw new Error('Studio is closing, so this window cannot connect to it now.')
      prune()
      const ticket = mintStudioTicket()
      outstanding.set(hashTicket(ticket), { windowKey: request.windowKey, origin: request.origin, mintedAt: now() })
      return {
        url: `ws://127.0.0.1:${listeningOn}${WINDOW_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`,
        token: ticket,
      }
    },
    revokeWindow(windowKey) {
      // Main names each document afresh, so a key once revoked is never asked for again.
      for (const [hash, entry] of outstanding) if (entry.windowKey === windowKey) outstanding.delete(hash)
      for (const connection of connections.get(windowKey) ?? [])
        connection.bye('revoked', 'This window has closed its connection to Studio.')
      connections.delete(windowKey)
    },
    address: () => (port === null ? null : `ws://127.0.0.1:${port}`),
    async stop() {
      stopped = true
      const closing = server
      server = null
      port = null
      listening = null
      outstanding.clear()
      connections.clear()
      if (!closing) return
      closing.closeAllConnections()
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    },
  }
}
