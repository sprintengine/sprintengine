import { connect } from 'node:net'
import { createInterface } from 'node:readline'

import { createStudioConversationParts } from '../../../src/renderer/src/components/panels/agentChat/studioChat'
import type { StudioClient, StudioWebSocketConstructor } from '../../../packages/client-runtime/src/public'
import {
  configureWindowStudio,
  watchWindowStudio,
  windowStudioClient,
  windowStudioState,
} from '../../../src/renderer/src/studio/windowStudioClient'
import type { ScheduledMessagesState } from '../../../src/shared/scheduled-messages'
import { conversationNewChatSeed } from '../../../src/renderer/src/components/workspace/conversationSpawnOptions'
import type { AgentState } from '../../../src/shared/agent-state'
import type { ConversationSessionFrame } from '../../../src/shared/conversation-runtime'
import type { StudioWindowTicket } from '../../../src/shared/studio-connection'
import { GATE_WINDOW_ORIGIN, MOCK_PROVIDER, type Attachment, type ChatRef, type GateClient } from '../client'
import type { Cutter } from '../cutter'
import { Feed } from '../feed'

// The desktop window: its Studio client (`windowStudioClient`) and the chat
// view's calls over it (`createStudioConversationParts`), the code a window
// runs with its chats on the Studio protocol. Before each connection it asks
// for a ticket, as a window asks main (here the server host's ticket broker,
// which asks the server's `rpc.windowTicket`), then opens a WebSocket to the
// server's real window listener, through the gate's cutter, with the origin a
// window loaded from the app's files says.

type TicketApi = NonNullable<Parameters<typeof windowStudioClient>[0]>

/** Main's half: a ticket for the window's next connection, asked of the host's broker. */
function brokerTicketApi(brokerPath: string, cutter: Cutter): TicketApi {
  return {
    studioWindowTicket: () =>
      new Promise<StudioWindowTicket>((resolve, reject) => {
        const socket = connect(brokerPath)
        socket.once('close', () => reject(new Error('The window could not get a ticket from Studio.')))
        socket.on('error', () => undefined)
        // While the server restarts its broker is gone: the window's client tries again.
        const lines = createInterface({ input: socket })
        lines.on('error', () => undefined)
        lines.once('line', (line) => {
          const ticket = JSON.parse(line) as StudioWindowTicket
          // The window dials the listener through its cutter; the path and ticket stay.
          const address = cutter.address
          if (!('port' in address)) return reject(new Error('The desktop’s cutter has no port.'))
          const url = new URL(ticket.url)
          url.port = String(address.port)
          resolve({ ...ticket, url: url.toString() })
        })
      }),
  } as TicketApi
}

/** Node's WebSocket, saying the origin a desktop window's says. */
function windowWebSocket(): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin: GATE_WINDOW_ORIGIN } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

function fail(result: unknown, what: string): void {
  const outcome = result as { ok?: boolean; message?: string } | undefined
  if (!outcome || outcome.ok === false) throw new Error(`desktop: ${what}: ${outcome?.message ?? 'no answer'}`)
}

/** Main's half of a window's New chat: the chat's record in its project, written over IPC. */
export type RecordChat = (chat: ChatRef, patch: Partial<AgentState>) => Promise<void>

export function desktopClient(
  cutter: Cutter,
  brokerPath: string,
  recordChat: RecordChat,
): GateClient & { studio(): Promise<StudioClient> } {
  const api = brokerTicketApi(brokerPath, cutter)
  configureWindowStudio(api, { WebSocket: windowWebSocket() })
  const parts = createStudioConversationParts(() => windowStudioClient(api))
  const sessions = new Map<string, string>()
  const keyOf = (chat: ChatRef) => `${chat.workspaceId}/${chat.agentId}`
  const stops: Array<() => void> = []

  // What the view does for a chat it shows: a session is started (or the
  // chat's own resumed) before the first send, and again after Studio lost it.
  async function session(chat: ChatRef, fresh = false): Promise<string> {
    const known = sessions.get(keyOf(chat))
    if (known && !fresh) return known
    const started = await parts.startSession!({ ...chat, ...MOCK_PROVIDER })
    fail(started, 'start a session')
    const sessionId = (started as { session: { sessionId: string } }).session.sessionId
    sessions.set(keyOf(chat), sessionId)
    return sessionId
  }

  /** A call on the chat's session, started again once if Studio no longer has it (after a restart). */
  async function onSession(chat: ChatRef, what: string, call: (sessionId: string) => Promise<unknown>) {
    const first = (await call(await session(chat))) as { ok?: boolean; message?: string }
    if (first?.ok !== false || !/session/iu.test(first.message ?? '')) return fail(first, what)
    fail(await call(await session(chat, true)), what)
  }

  return {
    id: 'desktop',
    label: 'Desktop window',
    transport: 'Studio protocol (window WebSocket)',
    simulated: [
      "Electron's preload and main's window tickets: the host asks the server's rpc.windowTicket for each connection, as main does",
      "the chat view's resubscribe if a stream ends (a React hook): the gate subscribes again from its cursor, though the window's client resumes its streams itself across a drop",
      "a New chat's record in its project, which the window writes to main over IPC: the server host writes it",
    ],
    async follow(chat) {
      const feed = new Feed('desktop')
      let stopped = false
      let stop: (() => void) | null = null
      // The chat's tray: every chat's scheduled messages, as the window's
      // store follows them (`scheduledMessages.*`), read again when the
      // connection opens, since a change made while it was down is not pushed.
      const showScheduled = (state: ScheduledMessagesState) =>
        feed.side({
          scheduled: state.messages
            .filter((message) => message.workspaceId === chat.workspaceId && message.agentId === chat.agentId)
            .map((message) => ({ id: message.id, text: message.text })),
        })
      const readScheduled = () =>
        void windowStudioClient(api)
          .then((client) => client.request('scheduledMessages.get', {}))
          .then(showScheduled, () => undefined)
      const studio = await windowStudioClient(api)
      const stopScheduled = studio.subscribe('scheduledMessages.changed', {}, { onPayload: showScheduled })
      readScheduled()
      let wasOpen = windowStudioState(api) === 'open'
      const unwatch = watchWindowStudio(api, () => {
        const open = windowStudioState(api) === 'open'
        if (open && !wasOpen) readScheduled()
        wasOpen = open
      })
      const subscribe = () => {
        if (stopped) return
        stop = parts.subscribe(
          {
            key: chat,
            turnLimit: 50,
            ...(feed.cursor === undefined ? {} : { afterSeq: feed.cursor }),
            ...(feed.generation === undefined ? {} : { generation: feed.generation }),
          },
          (frame: ConversationSessionFrame) => {
            if (frame.type === 'snapshot') {
              feed.snapshot(frame.page.events, {
                ...(frame.reset ? { reset: true } : {}),
                ...(frame.generation ? { generation: frame.generation } : {}),
              })
              feed.side({ live: true })
            } else if (frame.type === 'event') {
              feed.event(frame.event)
              feed.side({ live: true })
            } else if (frame.type === 'error') {
              feed.side({ live: false, lastError: frame.message })
              stop?.()
              setTimeout(subscribe, 250)
            }
          },
        )
      }
      subscribe()
      stops.push(() => {
        stopped = true
        stop?.()
        stopScheduled()
        unwatch()
      })
      return feed
    },
    async createChat(workspace, agentId) {
      const chat = { ...workspace, agentId }
      // The window's New chat: the record its project keeps, then the session.
      const seed = conversationNewChatSeed(
        { provider: { ...MOCK_PROVIDER, modelLabel: 'Mock' } },
        { permissionPreset: 'manual' },
      )
      if (!seed) throw new Error('desktop: the New chat seed names no provider')
      await recordChat(chat, seed.agentPatch as Partial<AgentState>)
      await session(chat, true)
      return chat
    },
    send: (chat, text) => onSession(chat, 'send', (sessionId) => parts.send({ sessionId, message: text })),
    sendWithAttachment: (chat, text, attachment: Attachment) =>
      onSession(chat, 'send with a picture', (sessionId) =>
        parts.send({
          sessionId,
          message: text,
          attachments: [
            {
              id: `picture-${Date.now()}`,
              name: attachment.name,
              mediaType: attachment.mediaType,
              dataBase64: attachment.bytes.toString('base64'),
            },
          ],
        } as never),
      ),
    answerApproval: (chat, requestId, approve) =>
      onSession(chat, 'answer an approval', (sessionId) => parts.respond({ sessionId, requestId, approved: approve })),
    messageSubagent: (chat, toolUseId, text) =>
      onSession(chat, 'message a sub-agent', (sessionId) =>
        parts.messageSubagent!({ sessionId, toolUseId, message: text }),
      ),
    // The composer's "+": the chat's message kept by its Studio for a time
    // (`scheduledMessages.update`), as the window's store asks.
    async scheduleSend(chat, text, sendAt) {
      const client = await windowStudioClient(api)
      await client.request('scheduledMessages.update', {
        commandId: `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        update: { kind: 'schedule', workspaceId: chat.workspaceId, agentId: chat.agentId, text, sendAt },
      })
    },
    async sendScheduledNow(_chat, scheduledId) {
      const client = await windowStudioClient(api)
      await client.request('scheduledMessages.update', {
        commandId: `send-now-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        update: { kind: 'send-now', id: scheduledId },
      })
    },
    /** The window's own Studio client: an owner's connection, for asks the gate checks against. */
    studio: () => windowStudioClient(api),
    cut: () => cutter.cut(),
    heal: () => cutter.heal(),
    async close() {
      for (const stop of stops.splice(0)) stop()
      ;(await windowStudioClient(api).catch(() => null))?.close()
    },
  }
}
