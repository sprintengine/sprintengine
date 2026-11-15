import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'

import { parseAgentStateFrame, type AgentStateFrame } from '../../main/agent-state'
import { withOwnerOnlyUmask } from '../../main/private-socket-dir'

// The agent-state reporter's listener: the local socket (a named pipe on
// Windows) the hooks of every terminal agent this Studio starts write
// newline-delimited JSON frames to. Each line is validated and the valid
// frames go to `onFrame`, the terminal runtime, which finds the session and
// moves its phase. It runs where the terminal runtime runs, in the Studio
// server (studio-agent-terminals.ts), in every mode.
//
// A WSL distribution's terminal agents report to a listener of this kind in
// the distribution's own Studio, which relays each valid line back to the
// desktop that holds it (`wsl/agent-state-relay.ts`); the desktop hands each
// relayed line to `ingestLine`, which holds it to exactly the same validation.
//
// The path is derived from the data directory (`resolveAgentStateSocketPath`),
// so the launch's environment and the hooks the shell writes into a plugin
// copy name it without asking this process.

/** A reporter frame is tiny; a client that streams an unbounded line without a newline is dropped. */
const MAX_LINE_BYTES = 64 * 1024

export type AgentStateListenerOptions = {
  socketPath: string
  /** A valid frame, with the line it was read from (what a distribution relays on). */
  onFrame: (frame: AgentStateFrame, line: string) => void
  logDiagnostic?: (diagnostic: { level: 'warning' | 'info'; title: string; message: string; details?: string }) => void
  now?: () => number
}

export type AgentStateListener = {
  /** Listen on the socket. Resolves once listening, or once the failure is logged: frames then go unheard. */
  start(): Promise<void>
  stop(): Promise<void>
  /** One frame line from elsewhere (a WSL distribution's relay). */
  ingestLine(line: string): void
  readonly socketPath: string
  isRunning(): boolean
}

export function createAgentStateListener(options: AgentStateListenerOptions): AgentStateListener {
  const now = options.now ?? (() => Date.now())
  const path = options.socketPath
  let server: Server | null = null
  let starting: Promise<void> | null = null
  let stopped = false
  const sockets = new Set<Socket>()

  function warn(title: string, details: string): void {
    options.logDiagnostic?.({ level: 'warning', title, message: title, details })
  }

  async function listen(): Promise<void> {
    // A stale socket file from a crashed previous run would block listen().
    // A live second listener is kept off upstream: only the process holding
    // the data directory's lock starts one.
    if (process.platform !== 'win32' && existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        // listen() surfaces a real conflict below.
      }
    }
    const next = createServer((socket) => handleConnection(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          next.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          next.removeListener('error', onError)
          resolve()
        }
        next.once('error', onError)
        next.once('listening', onListening)
        // Created owner-only, not narrowed after the fact.
        if (process.platform === 'win32') next.listen(path)
        else withOwnerOnlyUmask(() => next.listen(path))
      })
    } catch (error) {
      warn('Agent-state socket failed to start', message(error))
      return
    }
    if (stopped) {
      next.close()
      return
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600)
      } catch {
        // Owner-only is best-effort hardening; a failure does not break the feed.
      }
    }
    next.on('error', (error) => warn('Agent-state socket error', error.message))
    // Never what keeps a process alive: the process's own work does that.
    next.unref()
    server = next
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) ingestLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  }

  function ingestLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // Untrusted input: a malformed frame is dropped, never thrown on.
      return
    }
    const frame = parseAgentStateFrame(raw, now())
    if (!frame) return
    try {
      options.onFrame(frame, line)
    } catch (error) {
      warn('Agent-state frame handler threw', message(error))
    }
  }

  return {
    socketPath: path,
    start() {
      stopped = false
      starting ??= listen().finally(() => {
        starting = null
      })
      return starting
    },
    async stop() {
      stopped = true
      await starting
      const current = server
      server = null
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
      if (current && process.platform !== 'win32' && existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          // Best effort; a stale socket is unlinked at the next start.
        }
      }
    },
    ingestLine,
    isRunning: () => server !== null,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
