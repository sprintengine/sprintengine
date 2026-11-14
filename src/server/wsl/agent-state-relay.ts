import type { Duplex } from 'node:stream'

// A WSL distribution's terminal agents report their phases to this PC.
//
// WSL terminals are this PC's `wsl.exe` ptys, so their sessions, and the
// listener that moves their phases, are the desktop's. Their hooks, status
// line and OpenCode plugin run inside Linux, though, and write to a Unix
// socket there. The distribution's own Studio listens on it (the same
// listener a desktop's terminals report to, `terminals/agent-state-listener.ts`)
// and relays each valid line, as it arrived, on the `agent-state` purpose of
// its front door. Only the desktop that started that Studio can open the
// purpose: the front door admits it with the owner token's proof.
//
// The desktop opens the purpose on every connection to the distribution's
// Studio and hands each line to its own listener's `ingestLine`, which holds
// it to exactly the rules a frame on its own socket is held to.

/** A reporter frame is small; a line longer than this is not one. */
export const MAX_RELAYED_LINE_BYTES = 64 * 1024
// What the desktop has not read yet before lines are dropped: a desktop that
// stopped reading must not fill this server's memory.
const MAX_UNREAD_BYTES = 4 * 1024 * 1024

/** The distribution's side: the desktop's open streams, each sent every valid line. */
export type AgentStateRelay = {
  /** A stream the front door admitted for `agent-state`. */
  attach(stream: Duplex): void
  /** One valid frame line from the distribution's listener. */
  send(line: string): void
  /** How many desktops' streams are open. */
  size(): number
  close(): void
}

export function createAgentStateRelay(): AgentStateRelay {
  const streams = new Set<Duplex>()
  const drop = (stream: Duplex) => {
    if (!streams.delete(stream)) return
    stream.destroy()
  }
  return {
    attach(stream) {
      streams.add(stream)
      // The desktop says nothing on this stream; anything it sends is read and
      // dropped, so the stream never stalls on a full buffer.
      stream.on('data', () => undefined)
      stream.on('error', () => drop(stream))
      stream.on('close', () => drop(stream))
      stream.on('end', () => drop(stream))
    },
    send(line) {
      if (Buffer.byteLength(line, 'utf8') > MAX_RELAYED_LINE_BYTES || line.includes('\n')) return
      for (const stream of streams) {
        if (stream.writableLength > MAX_UNREAD_BYTES) continue
        stream.write(`${line}\n`)
      }
    },
    size: () => streams.size,
    close() {
      for (const stream of [...streams]) drop(stream)
    },
  }
}

/**
 * The desktop's side: reads the lines a distribution relays and hands each to
 * `ingest`. A line longer than a frame can be ends the stream. Resolves when
 * the stream ends.
 */
export function readRelayedAgentState(stream: Duplex, ingest: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          try {
            ingest(line)
          } catch {
            // The listener's failure is its own; the next line still goes.
          }
        }
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_RELAYED_LINE_BYTES) stream.destroy()
    })
    // The server's end of the stream is the stream ended: a half-open one
    // (the stdio bridge keeps its socket so) would never say it closed.
    stream.on('end', () => stream.destroy())
    stream.on('error', () => undefined)
    stream.on('close', () => resolve())
  })
}

/** What following a distribution's reports needs of a connection to its Studio. */
export type RelayingConnection = {
  distro: string
  owner: { readonly closed: Promise<unknown>; readonly state: string }
  open(purpose: 'agent-state'): Promise<Duplex>
}

// A stream that ended while its server's connection stands (the server ended
// it, the bridge hiccupped) is opened again after this long.
const REOPEN_MS = 2_000

/**
 * Follows one connection's relayed reports for as long as it stands: opens
 * the `agent-state` purpose, hands each line to `ingest`, and opens it again
 * if it ends while the connection lives. The next connection follows its own.
 */
export async function followRelayedAgentState(
  connection: RelayingConnection,
  ingest: (line: string) => void,
  log: (message: string) => void = () => undefined,
  reopenMs = REOPEN_MS,
): Promise<void> {
  let ended = false
  void connection.owner.closed.then(
    () => (ended = true),
    () => (ended = true),
  )
  while (!ended && connection.owner.state !== 'closed') {
    let stream: Duplex
    try {
      stream = await connection.open('agent-state')
    } catch (error) {
      if (ended || connection.owner.state === 'closed') return
      log(
        `The Studio server in ${connection.distro} did not relay its terminal agents' reports: ${error instanceof Error ? error.message : String(error)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, reopenMs).unref?.())
      continue
    }
    const closing = () => stream.destroy()
    void connection.owner.closed.then(closing, closing)
    await readRelayedAgentState(stream, ingest)
    if (ended || connection.owner.state === 'closed') return
    await new Promise((resolve) => setTimeout(resolve, reopenMs).unref?.())
  }
}
