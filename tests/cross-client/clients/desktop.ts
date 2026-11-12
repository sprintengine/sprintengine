import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { createStudioConversationParts } from '../../../src/renderer/src/components/panels/agentChat/studioChat'
import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { windowStudioClient } from '../../../src/renderer/src/studio/windowStudioClient'
import { conversationNewChatSeed } from '../../../src/renderer/src/components/workspace/conversationSpawnOptions'
import type { AgentState } from '../../../src/shared/agent-state'
import type { ConversationSessionFrame } from '../../../src/shared/conversation-runtime'
import type { StudioConnectResult } from '../../../src/shared/studio-connection'
import { MOCK_PROVIDER, type Attachment, type ChatRef, type GateClient } from '../client'
import type { Cutter } from '../cutter'
import { Feed } from '../feed'

// The desktop window: its Studio client (`windowStudioClient`) and the chat
// view's calls over it (`createStudioConversationParts`), the code a window
// runs with its chats on the Studio protocol. Main's preload and port broker
// are what this stands in for: a window's `studioConnect` here dials the
// server host's broker (through the gate's cutter), which hands the port to
// the same `rpc.connectWindow` the shell does.

type PortApi = Parameters<typeof windowStudioClient>[0]

/** The preload's half of the window's port API, over a socket per connection. */
function socketPortApi(cutter: Cutter): PortApi {
  const sockets = new Map<string, { socket: Socket; frames: string[]; listen?: (frame: string) => void }>()
  return {
    studioConnect: () =>
      new Promise<StudioConnectResult>((resolve, reject) => {
        const address = cutter.address
        const socket = 'path' in address ? connect(address.path) : connect(address.port, '127.0.0.1')
        let entry: { socket: Socket; frames: string[]; listen?: (frame: string) => void } | null = null
        socket.once('close', () => reject(new Error('The window could not reach Studio.')))
        socket.on('error', () => undefined)
        createInterface({ input: socket }).on('line', (line) => {
          if (!entry) {
            const connection = JSON.parse(line) as StudioConnectResult
            entry = { socket, frames: [] }
            sockets.set(connection.connectionId, entry)
            resolve(connection)
            return
          }
          if (entry.listen) entry.listen(line)
          else entry.frames.push(line)
        })
      }),
    studioPortSend: (connectionId, frame) => {
      sockets.get(connectionId)?.socket.write(`${frame}\n`)
    },
    studioPortListen: (connectionId, onFrame, onClose) => {
      const entry = sockets.get(connectionId)
      if (!entry) {
        queueMicrotask(onClose)
        return
      }
      entry.listen = onFrame
      for (const frame of entry.frames.splice(0)) onFrame(frame)
      entry.socket.once('close', () => {
        sockets.delete(connectionId)
        onClose()
      })
    },
    studioPortClose: (connectionId) => {
      sockets.get(connectionId)?.socket.destroy()
      sockets.delete(connectionId)
    },
  } as PortApi
}

function fail(result: unknown, what: string): void {
  const outcome = result as { ok?: boolean; message?: string } | undefined
  if (!outcome || outcome.ok === false) throw new Error(`desktop: ${what}: ${outcome?.message ?? 'no answer'}`)
}

/** Main's half of a window's New chat: the chat's record in its project, written over IPC. */
export type RecordChat = (chat: ChatRef, patch: Partial<AgentState>) => Promise<void>

export function desktopClient(
  cutter: Cutter,
  recordChat: RecordChat,
): GateClient & { studio(): Promise<StudioClient> } {
  const api = socketPortApi(cutter)
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
    transport: 'Studio protocol (window port)',
    simulated: [
      "Electron's preload and main port broker: a socket per window connection to the same rpc.connectWindow",
      "the chat view's resubscribe if a stream ends (a React hook): the gate subscribes again from its cursor, though the window's client resumes its streams itself across a drop",
      "a New chat's record in its project, which the window writes to main over IPC: the server host writes it",
    ],
    async follow(chat) {
      const feed = new Feed('desktop')
      let stopped = false
      let stop: (() => void) | null = null
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
    // The window's chat over the Studio protocol has no call for these yet:
    // they reach main over IPC (conversationTransport.ts).
    messageSubagent: undefined,
    scheduleSend: undefined,
    sendScheduledNow: undefined,
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
