import { pathToFileURL } from 'node:url'

import type { Attachment, ChatRef, GateClient } from '../client'
import type { Cutter } from '../cutter'
import { Feed, type GateEvent } from '../feed'

// The phone: its own protocol client, the modules under mobile/src/api that
// the app calls (mobile/src/__gate__/phoneProtocol.ts names them), bundled for
// Node with `expo-file-system/legacy` replaced by a Node upload of the same
// file (expo-file-system-node.ts). Node's global fetch and WebSocket stand in
// for React Native's.
//
// The types below are the gate's reading of the phone's API, which the phone's
// typecheck does not see: a changed signature shows when the gate runs.

type PhoneFrame = {
  type: string
  event?: GateEvent
  page?: { events: GateEvent[] }
  reset?: boolean
  generation?: string
  messages?: Array<{ id: string; text: string }>
  commandId?: string
  ok?: boolean
  message?: string
  code?: string
}

type PhoneStream = {
  command(command: Record<string, unknown>, commandId?: string): string
  foreground(backgroundMs: number): void
  close(): void
}

type PhoneApi = {
  open(
    key: { workspaceId: string; agentId: string },
    afterSeq: number,
    handlers: { onState(state: string, detail?: string): void; onFrame(frame: PhoneFrame): void },
    options?: Record<string, unknown>,
  ): PhoneStream
  uploadImage(input: { sessionId: string; uri: string; name: string; mediaType: string }): Promise<string>
  list(): Promise<Array<{ workspaceId: string; agentId: string; sessionId?: string | null }>>
}

export type PhoneProtocol = {
  completeTailnetPairing(input: {
    baseUrl: string
    pairingToken: string
    deviceName: string
  }): Promise<
    | { ok: true; data: { deviceToken: string; transport: { capabilities?: string[] | null } } }
    | { ok: false; message: string }
  >
  createConversation(
    target: { baseUrl: string; deviceToken: string; machineName: string },
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; title?: string; message?: string }>
  createTailnetConversationsApi(input: { baseUrl: string; deviceToken: string }): PhoneApi
}

export async function phoneClient(input: {
  cutter: Cutter
  protocol: PhoneProtocol
  pairingToken: () => Promise<string>
}): Promise<GateClient> {
  const address = input.cutter.address
  if (!('port' in address)) throw new Error('The phone reaches the server by a port.')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const paired = await input.protocol.completeTailnetPairing({
    baseUrl,
    pairingToken: await input.pairingToken(),
    deviceName: 'android-phone',
  })
  if (!paired.ok) throw new Error(`phone: pairing was refused: ${paired.message}`)
  const deviceToken = paired.data.deviceToken
  const capabilities = new Set(paired.data.transport.capabilities ?? [])
  const api = input.protocol.createTailnetConversationsApi({ baseUrl, deviceToken })
  const streams = new Map<string, { stream: PhoneStream; results: Map<string, (frame: PhoneFrame) => void> }>()
  const keyOf = (chat: ChatRef) => `${chat.workspaceId}/${chat.agentId}`

  async function command(chat: ChatRef, what: string, body: Record<string, unknown>): Promise<void> {
    const open = streams.get(keyOf(chat))
    if (!open) throw new Error(`phone: ${what}: the chat is not open`)
    const id = `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const answered = new Promise<PhoneFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`phone: ${what}: no answer in 20 s`)), 20_000)
      open.results.set(id, (frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
    open.stream.command(body, id)
    const result = await answered
    if (result.ok === false) throw new Error(`phone: ${what}: ${result.code ?? ''} ${result.message ?? ''}`.trim())
  }

  /** The session a chat's upload names: the one the phone's chat list says it runs. */
  async function sessionOf(chat: ChatRef): Promise<string> {
    const listed = await api.list()
    const sessionId = listed.find(
      (thread) => thread.workspaceId === chat.workspaceId && thread.agentId === chat.agentId,
    )?.sessionId
    if (!sessionId) throw new Error('phone: the chat list names no session for the chat')
    return sessionId
  }

  return {
    id: 'phone',
    label: 'Phone',
    transport: 'tailnet lane (phone client)',
    simulated: [
      "the phone's native file module: an upload reads the file and posts it with Node's fetch",
      "background and foreground: the gate cuts the phone's socket and calls the stream's foreground()",
      'the tailnet: the listener is bound to loopback and no Tailscale whois names the phone',
    ],
    async follow(chat) {
      const feed = new Feed('phone')
      const results = new Map<string, (frame: PhoneFrame) => void>()
      const stream = api.open(
        { workspaceId: chat.workspaceId, agentId: chat.agentId },
        0,
        {
          onState: (state, detail) => feed.side({ live: state === 'live', lastError: detail ?? null }),
          onFrame: (frame) => {
            if (frame.type === 'snapshot' && frame.page)
              feed.snapshot(frame.page.events, {
                ...(frame.reset ? { reset: true } : {}),
                ...(frame.generation ? { generation: frame.generation } : {}),
              })
            else if (frame.type === 'event' && frame.event) feed.event(frame.event)
            else if (frame.type === 'scheduled' && frame.messages)
              feed.side({ scheduled: frame.messages.map((message) => ({ id: message.id, text: message.text })) })
            else if (frame.type === 'commandResult' && frame.commandId) {
              results.get(frame.commandId)?.(frame)
              results.delete(frame.commandId)
            }
          },
        },
        {
          hello: capabilities.has('conversation-hello'),
          queuedSends: capabilities.has('conversation-queued-sends'),
          scheduledSends: capabilities.has('conversation-scheduled-sends'),
          subagents: capabilities.has('conversation-subagents'),
        },
      )
      streams.set(keyOf(chat), { stream, results })
      return feed
    },
    async createChat(workspace, name) {
      // The phone's New chat: by the CLI it picked. The fake provider has none (gaps.ts).
      const created = await input.protocol.createConversation(
        { baseUrl, deviceToken, machineName: 'mac-mini' },
        { workspaceId: workspace.workspaceId, newChat: true, cli: 'mock-provider', prompt: name },
      )
      if (!created.ok) throw new Error(`phone: create: ${JSON.stringify(created)}`)
      throw new Error('phone: create answered ok for a CLI that has no chat runtime')
    },
    send: (chat, text) => command(chat, 'send', { kind: 'send', message: text, composedAt: Date.now() }),
    async sendWithAttachment(chat, text, attachment: Attachment) {
      const uploadId = await api.uploadImage({
        sessionId: await sessionOf(chat),
        uri: pathToFileURL(attachment.path).toString(),
        name: attachment.name,
        mediaType: attachment.mediaType,
      })
      await command(chat, 'send with a picture', {
        kind: 'send',
        message: text,
        uploadIds: [uploadId],
        composedAt: Date.now(),
      })
    },
    answerApproval: (chat, requestId, approve) =>
      command(chat, 'answer an approval', { kind: 'resolveApproval', requestId, decision: approve ? 'once' : 'deny' }),
    messageSubagent: (chat, toolUseId, text) =>
      command(chat, 'message a sub-agent', { kind: 'messageSubagent', toolUseId, message: text }),
    scheduleSend: (chat, text, sendAt) =>
      command(chat, 'schedule a send', { kind: 'scheduleSend', message: text, sendAt }),
    sendScheduledNow: (chat, scheduledId) =>
      command(chat, 'send a scheduled message now', { kind: 'sendScheduledNow', scheduledId }),
    cut: () => input.cutter.cut(),
    heal: () => input.cutter.heal(),
    resume() {
      // Back from the background after a while: the app tells each open stream.
      for (const { stream } of streams.values()) stream.foreground(60_000)
    },
    async close() {
      for (const { stream } of streams.values()) stream.close()
      streams.clear()
    },
  }
}
