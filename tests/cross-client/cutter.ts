import { createServer, connect, type Server, type Socket } from 'node:net'

// A pass-through in front of one client's way to the server: TCP to a port,
// or a socket path to a socket path. The gate cuts a client off the network
// with it — every connection it carries ends, and new ones are refused until
// it is healed — so "the connection dropped mid-stream" is made the way a
// network makes it, without a hook in the product.

export type Target = { port: number } | { path: string }

export type Cutter = {
  /** Where the client dials: a loopback port, or the socket path given. */
  readonly address: { port: number } | { path: string }
  /** End every connection and refuse new ones until `heal()`. */
  cut(): void
  heal(): void
  /** Connections carried so far, ever: a reconnect shows as a new one. */
  readonly opened: number
  close(): Promise<void>
}

export async function startCutter(target: Target, listenOn?: { path: string }): Promise<Cutter> {
  const live = new Set<Socket>()
  let blocked = false
  let opened = 0
  const server: Server = createServer((client) => {
    if (blocked) {
      client.destroy()
      return
    }
    opened += 1
    const upstream = 'port' in target ? connect(target.port, '127.0.0.1') : connect(target.path)
    live.add(client)
    live.add(upstream)
    const end = () => {
      client.destroy()
      upstream.destroy()
      live.delete(client)
      live.delete(upstream)
    }
    client.on('error', end).on('close', end)
    upstream.on('error', end).on('close', end)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (listenOn) server.listen(listenOn.path, resolve)
    else server.listen(0, '127.0.0.1', resolve)
  })
  const bound = server.address()
  const address = listenOn ? { path: listenOn.path } : { port: typeof bound === 'object' && bound ? bound.port : 0 }
  return {
    address,
    cut() {
      blocked = true
      for (const socket of live) socket.destroy()
      live.clear()
    },
    heal() {
      blocked = false
    },
    get opened() {
      return opened
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
