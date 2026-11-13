import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

// How a client on this computer reaches an environment's Studio that only
// main can reach (design-wsl-ssh-direct, target 2): a WSL distribution's or an
// SSH machine's server, behind its front door. Main keeps a loopback route
// for each such environment, a 127.0.0.1 port of its own, and splices every
// socket that connects there onto a fresh front-door stream for the `ws`
// purpose, which the machine's server hands to its own window listener.
//
// The route carries bytes and nothing else. It adds no credential: what
// admits a socket is the ticket the machine's window listener minted for it
// (asked for over main's owner connection, `environment.windowTicket`), from
// the origin and to the host it was minted for. A process on this computer
// that connects with no ticket is refused there, as one connecting to a local
// window listener is.
//
// The port is chosen once and kept for the run, so a window's route does not
// change when the machine's server restarts or its session is made again. A
// socket that arrives while no session is up is closed at once; the window's
// client backs off and asks for a fresh ticket, which waits for the machine.

/** Splice one socket onto a fresh stream to the environment; the socket is closed if none can be opened. */
export async function spliceToEnvironment(
  socket: Duplex,
  open: () => Promise<Duplex>,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  // Nothing is read until the far end is there to take it.
  socket.pause()
  let closed = false
  const onEarlyClose = () => {
    closed = true
  }
  socket.once('close', onEarlyClose)
  socket.on('error', () => undefined)
  let stream: Duplex
  try {
    stream = await open()
  } catch (error) {
    log(
      `A connection to the machine's Studio could not be carried: ${error instanceof Error ? error.message : String(error)}`,
    )
    socket.destroy()
    return
  }
  socket.off('close', onEarlyClose)
  if (closed || socket.destroyed) {
    stream.destroy()
    return
  }
  stream.on('error', () => undefined)
  // One side gone is both gone: a window's socket has no half-open use.
  const end = () => {
    socket.destroy()
    stream.destroy()
  }
  socket.once('close', end)
  stream.once('close', end)
  socket.pipe(stream)
  stream.pipe(socket)
  socket.resume()
}

export type LoopbackRoute = {
  /** The route's port on 127.0.0.1, listening from the first ask and kept for the run. */
  port(): Promise<number>
  /** Stop listening and close every socket it carries. */
  close(): Promise<void>
}

/** A 127.0.0.1 port whose every socket is spliced onto `open()`'s stream. */
export function createLoopbackRoute(options: {
  open: () => Promise<Duplex>
  log?: (message: string) => void
}): LoopbackRoute {
  const log = options.log ?? (() => undefined)
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let listening: Promise<number> | null = null
  let closed = false

  function listen(): Promise<number> {
    listening ??= new Promise<number>((resolve, reject) => {
      const next = createServer({ pauseOnConnect: true }, (socket) => {
        if (closed) {
          socket.destroy()
          return
        }
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        void spliceToEnvironment(socket, options.open, log)
      })
      next.once('error', (error) => {
        listening = null
        reject(error)
      })
      next.listen(0, '127.0.0.1', () => {
        server = next
        resolve((next.address() as AddressInfo).port)
      })
    })
    return listening
  }

  return {
    async port() {
      if (closed) throw new Error('This machine’s route has been closed.')
      return listen()
    },
    async close() {
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      const closing = server
      server = null
      listening = null
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()))
    },
  }
}
