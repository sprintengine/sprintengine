import type { StudioTransport, StudioTransportFactory } from './transport.js'

// A Studio connection over a WebSocket: one text message per frame each way.
// It runs wherever a `WebSocket` exists (a browser, Studio's own windows,
// React Native, Node 22 and later); pass `WebSocket` to use another.
//
// The ticket is asked for again before every connection, reconnects included,
// so a credential that is good once (a ticket minted for one connection) is
// never presented twice, and an address that moved (a Studio that restarted
// on another port) is found again.

/** Where one connection goes, and the credential its hello presents. */
export type StudioWebSocketTicket = { url: string; token: string }

/** The members of a WebSocket this reads: the standard ones. */
export type StudioWebSocketLike = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
}

export type StudioWebSocketConstructor = new (url: string) => StudioWebSocketLike

export type WebSocketTransportOptions = {
  /** Where the next connection goes and what its hello presents; asked once per connection. */
  ticket: () => Promise<StudioWebSocketTicket>
  /** The WebSocket to use; the global one when not given. */
  WebSocket?: StudioWebSocketConstructor
  /** Hears each socket's close code: a Studio may say why it closed one (a revoked session, say). */
  onSocketClose?: (code: number) => void
  /**
   * How long a socket may take to open before it is given up and the
   * connection fails, so a reconnect tries again (default ten seconds). A
   * socket a sleeping network left half-made would otherwise wait for ever.
   */
  openTimeoutMs?: number
}

const OPEN = 1
const OPEN_TIMEOUT_MS = 10_000

/** A transport over a fresh WebSocket per connection. */
export function webSocketTransport(options: WebSocketTransportOptions): StudioTransportFactory {
  return async () => {
    const { url, token } = await options.ticket()
    const WebSocketClass =
      options.WebSocket ?? (globalThis as { WebSocket?: StudioWebSocketConstructor }).WebSocket ?? null
    if (!WebSocketClass) throw new Error('This runtime has no WebSocket; pass one to webSocketTransport.')
    const socket = new WebSocketClass(url)
    const messageListeners: Array<(frame: string) => void> = []
    const closeListeners: Array<(error?: Error) => void> = []
    // Frames heard before the client listens wait here, in order.
    const early: string[] = []
    let closed = false
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      if (messageListeners.length === 0) early.push(event.data)
      else for (const listener of messageListeners) listener(event.data)
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        settle(new Error('Studio did not answer in time.'))
        socket.close()
      }, options.openTimeoutMs ?? OPEN_TIMEOUT_MS)
      socket.addEventListener('open', () => settle())
      socket.addEventListener('error', () => settle(new Error('Studio could not be reached.')))
      socket.addEventListener('close', (event) => {
        settle(new Error(`Studio refused the connection (${event.code}).`))
        options.onSocketClose?.(event.code)
        if (closed) return
        closed = true
        // Heard after the current frame, as a socket's close is elsewhere.
        queueMicrotask(() => {
          for (const listener of closeListeners.splice(0)) listener()
        })
      })
    })
    const transport: StudioTransport = {
      credential: { token },
      send: (frame) => {
        if (!closed && socket.readyState === OPEN) socket.send(frame)
      },
      close: () => {
        if (closed) return
        socket.close()
      },
      onMessage: (listener) => {
        messageListeners.push(listener)
        for (const frame of early.splice(0)) listener(frame)
      },
      onClose: (listener) => {
        if (closed) queueMicrotask(() => listener())
        else closeListeners.push(listener)
      },
    }
    return transport
  }
}
