import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { STUDIO_CONVERSATIONS_CAPABILITY } from '../../../packages/studio-protocol/src/public'
import { createTailnetMeshService } from '../../../src/main/automation/tailnet/tailnet-mesh-service'
import { createTailnetMeshStore } from '../../../src/main/automation/tailnet/tailnet-mesh-store'
import { pairingUrl } from '../../../src/main/automation/tailnet/tailnet-service'
import { createDataKeySecretCipher } from '../../../src/server/platform/secret-cipher'
import type { ConversationSessionFrame } from '../../../src/shared/conversation-runtime'
import type { MeshConversationKey } from '../../../src/shared/tailnet-mesh'
import type { Attachment, ChatRef, GateClient } from '../client'
import type { Cutter } from '../cutter'
import { openPairedWindow } from '../../paired-window'
import { createPairedChat } from '../../../src/renderer/src/studio/pairedDiscovery'
import { createPairedChatTransport } from '../../../src/renderer/src/components/panels/agentChat/pairedChat'
import type { ConversationTransport } from '../../../src/renderer/src/components/panels/agentChat/conversationTransport'
import { Feed } from '../feed'

// A second desktop, paired with the server's machine: its window's own client
// of that machine's Studio (`src/renderer/src/studio/environmentStudio.ts`),
// its tickets bought by the mesh with the pairing's device token, and the chat
// view's transport for a paired machine's chat over it (`pairedChat.ts`). It
// pairs with a code the server offers, as a person does from Settings; its
// own data directory is a fresh one.

export async function peerClient(input: {
  cutter: Cutter
  dataDir: string
  pairingToken: () => Promise<string>
}): Promise<GateClient> {
  // The pairing is sealed with the server platform's data-key cipher rather
  // than a keychain, which a CI runner has none of.
  const cipher = createDataKeySecretCipher(randomBytes(32))
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 })
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => input.dataDir,
    createStore: (options) => createTailnetMeshStore({ ...options, cipher }),
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const address = input.cutter.address
  if (!('port' in address)) throw new Error('The paired desktop reaches the server by a port.')
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', address.port, await input.pairingToken()) })
  if (!paired.ok) throw new Error(`peer: pairing was refused: ${paired.message}`)
  const connectionId = paired.connection.id
  // The window's own client of that machine's Studio, its tickets bought by the mesh.
  const closeWindow = openPairedWindow(mesh, connectionId)
  const machine = { id: connectionId, machineName: paired.connection.machineName }
  // One transport per chat, as the chat's pane makes it.
  const transports = new Map<string, ConversationTransport>()
  const transportOf = (chat: ChatRef): ConversationTransport => {
    const id = `${chat.workspaceId}/${chat.agentId}`
    let made = transports.get(id)
    if (!made) {
      const key: MeshConversationKey = { connectionId, workspaceId: chat.workspaceId, agentId: chat.agentId }
      made = createPairedChatTransport({ key, machineName: machine.machineName })
      transports.set(id, made)
    }
    return made
  }
  // The pane's key: a workspace here holds it; the transport names the chat there.
  const viewKey = (chat: ChatRef) => ({ workspaceRoot: '', workspaceId: 'pane-here', agentId: chat.agentId })
  const done = (result: { ok: boolean; message?: string }, what: string) => {
    if (!result.ok) throw new Error(`peer: ${what}: ${result.message ?? 'refused'}`)
  }
  const stops: Array<() => void> = []

  return {
    id: 'peer',
    label: 'Paired desktop',
    transport: "the window's client of /tailnet/v1/studio (Studio protocol), keyed commands",
    simulated: [
      'the tailnet: the listener is bound to loopback and no Tailscale whois names the peer',
      "the peer's keychain: its pairing is sealed with the server platform's data-key cipher",
      "the chat view's resubscribe if a stream ends (a React hook): the gate subscribes again from its cursor",
    ],
    async follow(chat) {
      const feed = new Feed('peer')
      const transport = transportOf(chat)
      let stopped = false
      let stop: (() => void) | null = null
      // The chat's tray, on its own push topic there, as the pane follows it.
      const stopScheduled =
        transport.services.followPush?.({
          topic: 'conversation.scheduled',
          params: { key: { workspaceId: chat.workspaceId, agentId: chat.agentId } },
          capability: STUDIO_CONVERSATIONS_CAPABILITY,
          onPayload: (frame) =>
            feed.side({ scheduled: frame.messages.map((message) => ({ id: message.id, text: message.text })) }),
        }) ?? (() => undefined)
      const subscribe = () => {
        if (stopped) return
        stop = transport.subscribe(
          {
            key: viewKey(chat),
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
      })
      return feed
    },
    async createChat(workspace, name) {
      // The way a paired desktop's window starts a chat: by the CLI its New
      // chat picked, on that machine's Studio. The fake provider has none (gaps.ts).
      const created = await createPairedChat(machine, {
        workspaceId: workspace.workspaceId,
        cli: 'mock-provider',
        prompt: name,
      })
      if (!created.ok) throw new Error(`peer: create: ${created.message}`)
      return { workspaceId: created.workspaceId, agentId: created.agentId, workspaceRoot: workspace.workspaceRoot }
    },
    send: async (chat, text) => done(await transportOf(chat).send({ sessionId: '', message: text }), 'send'),
    async sendWithAttachment(chat, text, attachment: Attachment) {
      const sent = await transportOf(chat).send({
        sessionId: '',
        message: text,
        attachments: [
          {
            id: `picture-${Date.now()}`,
            name: attachment.name,
            mediaType: attachment.mediaType,
            dataBase64: attachment.bytes.toString('base64'),
          },
        ],
      } as never)
      done(sent, 'send with a picture')
    },
    answerApproval: async (chat, requestId, approve) =>
      done(await transportOf(chat).respond({ sessionId: '', requestId, approved: approve }), 'answer an approval'),
    messageSubagent: async (chat, toolUseId, text) =>
      done(
        await transportOf(chat).messageSubagent!({ sessionId: '', toolUseId, message: text }),
        'message a sub-agent',
      ),
    scheduleSend: async (chat, text, sendAt) =>
      done(await transportOf(chat).scheduleSend!({ key: viewKey(chat), message: text, sendAt }), 'schedule a send'),
    sendScheduledNow: async (chat, scheduledId) =>
      done(
        await transportOf(chat).sendScheduledNow!({ key: viewKey(chat), scheduledId }),
        'send a scheduled message now',
      ),
    cut: () => input.cutter.cut(),
    heal: () => input.cutter.heal(),
    async close() {
      for (const stop of stops.splice(0)) stop()
      closeWindow()
      mesh.shutdown()
    },
  }
}
