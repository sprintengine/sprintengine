import {
  StudioError,
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import { requestTailnetJson, type TailnetEndpoint } from './tailnet-remote-client'
import { TAILNET_WS_TICKET_PATH } from './tailnet-routes'

// This Studio's client of a paired machine's Studio: the protocol every
// client speaks, on that machine's tailnet listener at `/tailnet/v1/studio`,
// through the shared client runtime. One connection per paired machine,
// opened on the first ask with the device token this machine holds for it,
// reconnecting by itself while it is used, and closed once it has sat idle.
//
// What it may ask is that machine's grant to this one, read there at every
// request: a narrowed pairing is refused `scope_required`, a removed one is
// closed. Each connection is opened with a ticket the token buys, good once
// for thirty seconds; the token never rides a URL. A Node socket says no
// Origin, which the listener requires of everything but a desktop window.

export type PeerStudioTarget = { id: string; endpoint: TailnetEndpoint; deviceToken: string; machineName: string }

/** Words for a machine whose Studio is from before the protocol. */
export function peerStudioOutdated(machineName: string): string {
  return `Update SprintEngine Studio on ${machineName} to use this from here.`
}

/**
 * A ticket for one connection to a paired machine's Studio, bought with the
 * device token this machine holds for it: good once, for thirty seconds. One
 * for a desktop window names the window's `origin`, and the far listener lets
 * only a socket saying exactly that origin open with it; one for this
 * process's own socket names none. Rejects with a `StudioError`: `unauthorized`
 * for a pairing the machine no longer knows, `outdated` for a machine from
 * before the protocol, `unavailable` for one that did not answer.
 */
export async function peerStudioTicket(
  target: Omit<PeerStudioTarget, 'id'>,
  origin?: string,
): Promise<{ url: string; token: string }> {
  let answer: Awaited<ReturnType<typeof requestTailnetJson>>
  try {
    answer = await requestTailnetJson({
      endpoint: target.endpoint,
      method: 'POST',
      path: TAILNET_WS_TICKET_PATH,
      token: target.deviceToken,
      body: origin === undefined ? {} : { origin },
    })
  } catch {
    throw new StudioError('unavailable', `${target.machineName} did not answer.`)
  }
  if (answer.status === 401)
    throw new StudioError('unauthorized', `${target.machineName} no longer knows this pairing.`)
  const body = answer.body as { ticket?: unknown; studioPath?: unknown } | null
  if (answer.status !== 200 || typeof body?.ticket !== 'string')
    throw new StudioError('unavailable', `${target.machineName} answered ${answer.status}.`)
  if (typeof body.studioPath !== 'string') throw new StudioError('outdated', peerStudioOutdated(target.machineName))
  const host = target.endpoint.host.includes(':') ? `[${target.endpoint.host}]` : target.endpoint.host
  return {
    url: `ws://${host}:${target.endpoint.port}${body.studioPath}?ticket=${encodeURIComponent(body.ticket)}`,
    token: body.ticket,
  }
}

/** How long a paired machine's connection is kept with nothing asked of it. */
const IDLE_CLOSE_MS = 5 * 60_000
/** How long one ask waits for an answer, unless it says otherwise. */
const ASK_TIMEOUT_MS = 15_000

type Held = {
  key: string
  opening: Promise<StudioClient>
  idle: ReturnType<typeof setTimeout> | null
  asking: number
  /** Holds that keep the connection open past its idle close: a board followed there. */
}

/** A paired machine's connection kept open for a stream that lives longer than one ask. */
export type PeerStudios = {
  /**
   * Ask a paired machine's Studio something, on its connection: opened now if
   * there is none. Rejects with a `StudioError`: `outdated` for a machine from
   * before the protocol, `unauthorized` for a pairing it no longer knows,
   * `unavailable` for one that did not answer in time, or the refusal it gave.
   */
  ask<T>(target: PeerStudioTarget, work: (client: StudioClient) => Promise<T>, timeoutMs?: number): Promise<T>
  /** Close a machine's connection: it was forgotten, or its token changed. */
  forget(connectionId: string): void
  closeAll(): void
}

export function createPeerStudios(
  options: { WebSocket?: StudioWebSocketConstructor; idleCloseMs?: number } = {},
): PeerStudios {
  const held = new Map<string, Held>()
  const idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS

  function close(connectionId: string): void {
    const entry = held.get(connectionId)
    if (!entry) return
    held.delete(connectionId)
    if (entry.idle) clearTimeout(entry.idle)
    entry.opening.then(
      (client) => client.close(),
      () => undefined,
    )
  }

  function open(target: PeerStudioTarget): Held {
    const key = `${target.endpoint.host}:${target.endpoint.port}\n${target.deviceToken}`
    const known = held.get(target.id)
    if (known && known.key === key) return known
    if (known) close(target.id)
    const NodeWebSocket =
      options.WebSocket ?? (globalThis as unknown as { WebSocket: StudioWebSocketConstructor }).WebSocket
    const opening = connect({
      client: { name: 'SprintEngine Studio' },
      transport: webSocketTransport({ ticket: () => peerStudioTicket(target), WebSocket: NodeWebSocket }),
      reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
    })
    const entry: Held = { key, opening, idle: null, asking: 0 }
    held.set(target.id, entry)
    const forget = () => {
      if (held.get(target.id) === entry) close(target.id)
    }
    opening.then((client) => client.closed.then(forget, forget), forget)
    return entry
  }

  /** Close it after the idle wait, once nothing asks of it. */
  function settle(target: PeerStudioTarget, entry: Held): void {
    if (entry.asking > 0 || held.get(target.id) !== entry) return
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (held.get(target.id) === entry && entry.asking === 0) close(target.id)
    }, idleCloseMs)
    // An idle connection waiting to close holds no process open.
    entry.idle.unref?.()
  }

  function use(target: PeerStudioTarget): Held {
    const entry = open(target)
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = null
    return entry
  }

  return {
    async ask(target, work, timeoutMs = ASK_TIMEOUT_MS) {
      const entry = use(target)
      entry.asking += 1
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          entry.opening.then(work),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new StudioError('unavailable', `${target.machineName} did not answer in time.`)),
              timeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        entry.asking -= 1
        settle(target, entry)
      }
    },
    forget: close,
    closeAll() {
      for (const connectionId of [...held.keys()]) close(connectionId)
    },
  }
}

/** Why a paired machine did not answer, in the kinds a caller tells apart. */
export type PeerRefusal = {
  kind: 'outdated' | 'unauthorized' | 'unavailable' | 'refused'
  /** The refusal's own code, for a caller that names it. */
  code: string
  message: string
}

/** A failed ask, read: an older Studio, a pairing it refuses, a machine away, or a refusal of what was asked. */
export function peerRefusal(target: { machineName: string }, error: unknown): PeerRefusal {
  const code = error instanceof StudioError ? error.code : 'unavailable'
  const message = error instanceof Error && error.message ? error.message : `${target.machineName} could not answer.`
  switch (code) {
    case 'outdated':
    case 'unknown_method':
    case 'unsupported_protocol_version':
      return { kind: 'outdated', code, message: peerStudioOutdated(target.machineName) }
    case 'unauthorized':
    case 'revoked':
    case 'peer_mismatch':
    case 'scope_required':
    case 'owner_required':
      return { kind: 'unauthorized', code, message }
    case 'unavailable':
    case 'closed':
      return { kind: 'unavailable', code, message }
    default:
      return { kind: 'refused', code, message }
  }
}
