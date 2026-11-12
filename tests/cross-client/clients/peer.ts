import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import {
  createTailnetMeshService,
  type TailnetMeshService,
} from '../../../src/main/automation/tailnet/tailnet-mesh-service'
import { createTailnetMeshStore } from '../../../src/main/automation/tailnet/tailnet-mesh-store'
import { pairingUrl } from '../../../src/main/automation/tailnet/tailnet-service'
import { createDataKeySecretCipher } from '../../../src/server/platform/secret-cipher'
import type { MeshConversationFrame, MeshConversationKey } from '../../../src/shared/tailnet-mesh'
import type { Attachment, ChatRef, GateClient } from '../client'
import type { Cutter } from '../cutter'
import { Feed } from '../feed'

// A second desktop, paired with the server's machine: the mesh service a
// desktop drives another machine's chats with (tailnet-mesh-service.ts), over
// the tailnet lane. It pairs with a code the server offers, as a person does
// from Settings; its own data directory is a fresh one.

export async function peerClient(input: {
  cutter: Cutter
  dataDir: string
  pairingToken: () => Promise<string>
}): Promise<GateClient & { mesh: TailnetMeshService }> {
  // The pairing is sealed with the server platform's data-key cipher rather
  // than a keychain, which a CI runner has none of.
  const cipher = createDataKeySecretCipher(randomBytes(32))
  mkdirSync(input.dataDir, { recursive: true, mode: 0o700 })
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => input.dataDir,
    createStore: (options) => createTailnetMeshStore({ ...options, cipher }),
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
    conversations: { retry: { baseMs: 100, maxMs: 1_000 }, requestTimeoutMs: 15_000 },
  })
  const address = input.cutter.address
  if (!('port' in address)) throw new Error('The paired desktop reaches the server by a port.')
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', address.port, await input.pairingToken()) })
  if (!paired.ok) throw new Error(`peer: pairing was refused: ${paired.message}`)
  const connectionId = paired.connection.id
  const keyOf = (chat: ChatRef): MeshConversationKey => ({
    connectionId,
    workspaceId: chat.workspaceId,
    agentId: chat.agentId,
  })
  const command = async (chat: ChatRef, what: string, body: Record<string, unknown>) => {
    const result = await mesh.conversationCommand({ key: keyOf(chat), command: body })
    if (!result.ok) throw new Error(`peer: ${what}: ${result.code}: ${result.message}`)
  }
  let follows = 0
  const followIds: string[] = []

  return {
    id: 'peer',
    label: 'Paired desktop',
    transport: 'tailnet lane (mesh service)',
    simulated: [
      'the tailnet: the listener is bound to loopback and no Tailscale whois names the peer',
      "the peer's keychain: its pairing is sealed with the server platform's data-key cipher",
    ],
    mesh,
    async follow(chat) {
      const feed = new Feed('peer')
      const followId = `gate-${++follows}`
      followIds.push(followId)
      const following = await mesh.followConversation({
        followId,
        key: keyOf(chat),
        turnLimit: 50,
        emit: (frame: MeshConversationFrame) => {
          if (frame.type === 'snapshot')
            feed.snapshot(frame.page.events, {
              ...(frame.reset ? { reset: true } : {}),
              ...(frame.generation ? { generation: frame.generation } : {}),
            })
          else if (frame.type === 'event') feed.event(frame.event)
          else if (frame.type === 'link') feed.side({ live: frame.state === 'live', lastError: frame.detail })
          else if (frame.type === 'scheduled')
            feed.side({ scheduled: frame.messages.map((message) => ({ id: message.id, text: message.text })) })
          else if (frame.type === 'error') feed.side({ lastError: frame.message })
        },
      })
      if (!following.ok) throw new Error(`peer: follow: ${following.message}`)
      return feed
    },
    async createChat(workspace, name) {
      // The way a paired desktop starts a chat: by the CLI its New chat
      // picked. The fake provider has none (gaps.ts).
      const created = await mesh.createConversation({
        connectionId,
        workspaceId: workspace.workspaceId,
        cli: 'mock-provider',
        prompt: name,
      })
      if (!created.ok) throw new Error(`peer: create: ${created.message}`)
      return { workspaceId: created.workspaceId, agentId: created.agentId, workspaceRoot: workspace.workspaceRoot }
    },
    send: (chat, text) => command(chat, 'send', { kind: 'send', message: text }),
    async sendWithAttachment(chat, text, attachment: Attachment) {
      const result = await mesh.conversationSend({
        key: keyOf(chat),
        message: text,
        attachments: [
          {
            id: `picture-${Date.now()}`,
            name: attachment.name,
            mediaType: attachment.mediaType,
            dataBase64: attachment.bytes.toString('base64'),
          },
        ],
      })
      if (!result.ok) throw new Error(`peer: send with a picture: ${result.code}: ${result.message}`)
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
    async close() {
      for (const followId of followIds) mesh.unfollowConversation(followId)
      mesh.shutdown()
    },
  }
}
