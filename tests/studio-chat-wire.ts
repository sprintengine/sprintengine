import {
  createStudioConversationParts,
  type StudioTransportParts,
} from '../src/renderer/src/components/panels/agentChat/studioChat'
import { configureWindowStudio, windowStudioClient } from '../src/renderer/src/studio/windowStudioClient'
import { createStudioChatBackend } from '../src/main/studio-rpc/studio-chat-backend'
import type { ConversationService } from '../src/main/conversation-service'
import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../src/server/rpc/studio-frame-port'
import { createStudioRpcServer } from '../src/server/rpc/studio-rpc-server'
import type { StudioConversationBackend } from '../src/server/rpc/studio-rpc-types'
import { createMemoryChannel } from './memory-channel'
import { memoryWebSocketClass } from './memory-websocket'

// A window's chat calls, the way a window makes them, against a conversation
// service: the window's client and its protocol parts, an in-memory socket,
// the real Studio RPC connection and router, and main's chat backend with
// the input checks every client meets. For a suite that holds the window's
// side and main's to each other without a renderer (a seam, a measurement).

const notServed = async () => ({ ok: false, message: 'Not served by this harness.' }) as never

/** Follows a chat by the service's own subscription; nothing is resolved by workspace. */
function conversationsOver(service: ConversationService): StudioConversationBackend {
  return {
    list: async () => [],
    resolveKey: () => null,
    follow(key, cursor, listener) {
      const subscription = service.subscribe?.({ key, ...cursor } as never, listener)
      return { dispose: () => subscription?.dispose(), ready: Promise.resolve() }
    },
    loadEarlier: notServed,
    toolDetail: notServed,
    event: notServed,
    turnDiff: notServed,
    command: async () => ({ ok: false, code: 'unavailable', message: 'A window drives a chat by its session.' }),
    stop: async () => ({ ok: true }),
    permissionOf: () => 'bypass',
    findCreated: () => null,
    create: async () => ({ ok: false, code: 'unavailable', message: 'A window starts a chat by its session.' }),
    redact: (value) => value,
  }
}

export type StudioChatWire = {
  parts: StudioTransportParts
  /** Every byte the server has sent the window so far; set it to 0 to start counting again. */
  bytes: { sent: number }
  close(): Promise<void>
}

export function connectChatOverStudio(service: ConversationService): StudioChatWire {
  const chat = createStudioChatBackend({
    conversation: service,
    readableRoots: () => ['/'],
    hasReceipt: async () => false,
    commands: notServed,
  })
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/studio-chat-wire',
    version: 'test',
    environmentId: 'studio-chat-wire',
    backend: conversationsOver(service),
    chat: () => chat,
    authenticator: createTicketAuthenticator(mintStudioTicket()),
  })
  const bytes = { sent: 0 }
  const api: Record<string, unknown> = {
    studioWindowTicket: async () => {
      const ticket = mintStudioTicket()
      return { url: `ws://127.0.0.1:1/ws?ticket=${encodeURIComponent(ticket)}`, token: ticket }
    },
  }
  configureWindowStudio(api, {
    WebSocket: memoryWebSocketClass((url) => {
      const ticket = new URL(url).searchParams.get('ticket')
      if (!ticket) return null
      const [serverEnd, windowEnd] = createMemoryChannel()
      const post = serverEnd.post
      serverEnd.post = (frame) => {
        bytes.sent += Buffer.byteLength(frame)
        post(frame)
      }
      server.attach(framePortStream(serverEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
      return windowEnd
    }),
  })
  return {
    parts: createStudioConversationParts(() => windowStudioClient(api as never)),
    bytes,
    close: async () => (await windowStudioClient(api as never)).close(),
  }
}
