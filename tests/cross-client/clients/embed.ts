import { connect, type StudioClient, type StudioTransport } from '../../../packages/agent-sdk/src/index'
import { connectEmbed } from '../../../src/renderer/src/web/embed/embedClient'
import type { ChatRef, GateClient } from '../client'
import type { Cutter } from '../cutter'
import { Feed } from '../feed'

// A page that frames one chat, read-only: the embed page's own client
// (embedClient.ts), which trades the embed's token for a ticket and follows its
// one conversation through the web listener. Its isolation is the point: the
// server's frame gate (embeds.ts) and its read-only grant hold it to that one
// chat, reading. `probe` asks for more, on a connection of its own, and says
// whether the server let it.

type EmbedLink = { embedId: string; token: string; url: string }

export function parseEmbedLink(url: string): EmbedLink {
  const parsed = new URL(url)
  const embedId = parsed.pathname.split('/').at(-1) ?? ''
  const token = new URLSearchParams(parsed.hash.slice(1)).get('token') ?? ''
  if (!embedId || !token) throw new Error(`embed: no id and token in ${url}`)
  return { embedId, token, url }
}

/** The ticket socket a page opens, under Node's WebSocket. */
function ticketSocket(url: string): Promise<StudioTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const messages: Array<(frame: string) => void> = []
    const closes: Array<(error?: Error) => void> = []
    socket.addEventListener('error', () => reject(new Error('Studio could not be reached.')), { once: true })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') for (const listener of messages) listener(event.data)
    })
    socket.addEventListener('close', () => {
      for (const listener of closes.splice(0)) listener()
    })
    socket.addEventListener(
      'open',
      () =>
        resolve({
          credential: { token: 'embed-ticket-spent' },
          send: (frame) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(frame)
          },
          close: () => socket.close(),
          onMessage: (listener) => void messages.push(listener),
          onClose: (listener) => void closes.push(listener),
        }),
      { once: true },
    )
  })
}

/** What became of one ask: answered, or refused with the words it was refused in. No answer at all is neither. */
export type ProbeAnswer = { allowed: true } | { allowed: false; why: string }

/** An ask's outcome within ten seconds; one that hangs throws, since silence proves nothing. */
export async function answerOf(asked: Promise<unknown>): Promise<ProbeAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the ask had no answer in 10 s')), 10_000)
  })
  try {
    await Promise.race([asked, hung])
    return { allowed: true }
  } catch (error) {
    if (error instanceof Error && error.message === 'the ask had no answer in 10 s') throw error
    return { allowed: false, why: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export function embedClient(input: { cutter: Cutter; link: () => Promise<EmbedLink> }): GateClient & {
  /** One ask on a connection of the embed's own, as a page holding its token could open. */
  probe(ask: (client: StudioClient) => Promise<unknown>): Promise<ProbeAnswer>
} {
  const address = input.cutter.address
  if (!('port' in address)) throw new Error('The embed reaches the server by a port.')
  const origin = `http://127.0.0.1:${address.port}`
  // A browser names the page's origin on every POST it makes; Node's fetch
  // names none. The page's own requests get it here, and nobody else's.
  const nodeFetch = globalThis.fetch
  globalThis.fetch = (request, init) => {
    const url = request instanceof Request ? request.url : String(request)
    if (!url.startsWith(`${origin}/`)) return nodeFetch(request, init)
    const headers = new Headers(init?.headers)
    headers.set('origin', origin)
    return nodeFetch(request, { ...init, headers })
  }
  let connected: StudioClient | null = null
  const stops: Array<() => void> = []

  return {
    id: 'embed',
    label: 'Embedded chat (read-only)',
    transport: 'Studio protocol (web listener, embed ticket)',
    simulated: [
      "the framing page: the embed client runs under Node with the page's address set, and its POSTs carry the Origin a browser would send",
    ],
    async follow(chat: ChatRef) {
      const link = await input.link()
      // The page's address, as the frame was loaded from it (through the cutter).
      const path = new URL(link.url)
      ;(globalThis as { window?: unknown }).window = { location: { href: `${origin}${path.pathname}${path.hash}` } }
      const { client, conversation } = await connectEmbed(link.embedId, link.token)
      if (conversation.workspaceId !== chat.workspaceId || conversation.agentId !== chat.agentId)
        throw new Error('embed: the embed names another chat')
      connected = client
      const feed = new Feed('embed')
      stops.push(
        client.conversations.follow(conversation, { turnLimit: 50 }, (frame) => {
          if (frame.type === 'snapshot')
            feed.snapshot(frame.page.events as never, {
              ...(frame.reset ? { reset: true } : {}),
              ...(frame.generation ? { generation: frame.generation } : {}),
            })
          else if (frame.type === 'event') feed.event(frame.event as never)
          else if (frame.type === 'error') feed.side({ lastError: frame.message })
        }),
      )
      return feed
    },
    async probe(ask) {
      const link = await input.link()
      const session = await fetch(`${origin}/embed/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ embedId: link.embedId, token: link.token }),
      })
      const { ticket } = (await session.json()) as { ticket: string }
      const client = await connect({
        client: { name: 'Embedded conversation (probe)' },
        transport: () => ticketSocket(`ws://127.0.0.1:${address.port}/ws?ticket=${encodeURIComponent(ticket)}`),
        reconnect: false,
        wakeups: false,
      })
      return answerOf(ask(client)).finally(() => client.close())
    },
    cut: () => input.cutter.cut(),
    heal: () => input.cutter.heal(),
    async close() {
      for (const stop of stops.splice(0)) stop()
      connected?.close()
    },
  }
}
