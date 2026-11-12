import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import { CONVERSATION_WIRE_PAGE_BYTES } from '../../server/conversation-stream-shaping'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import {
  MESH_CONVERSATION_EARLIER_CHANNEL,
  MESH_CONVERSATION_FOLLOW_CHANNEL,
  type MeshConversationFrame,
} from '../../shared/tailnet-mesh'
import { registerMeshIpc } from './mesh-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

// A paired machine on an older build sends its chat as stored: the window here
// reads it as every wire sends a chat, results once and a page bounded.
test('a paired machine’s chat reaches the window projected and bounded, whatever build the machine runs', async () => {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: () => undefined,
  } as unknown as IpcMain
  const events = Array.from(
    { length: 1200 },
    (_, index) =>
      ({
        id: `e${index + 1}`,
        seq: index + 1,
        sessionId: 's',
        workspaceId: 'w',
        agentId: 'a',
        providerId: 'p',
        modelId: 'm',
        createdAt: 1,
        type: 'tool_output',
        payload: { toolUseId: `t${index}`, preview: 'r'.repeat(4000), output: 'r'.repeat(4000), isError: false },
      }) as ConversationEvent,
  )
  const page = { events, hasMore: false, beforeCursor: 1 }
  let emit!: (frame: MeshConversationFrame) => void
  const mesh = {
    followConversation: (input: { emit: (frame: MeshConversationFrame) => void }) => {
      emit = input.emit
      return { ok: true }
    },
    conversationLoadEarlier: async () => ({ ok: true, page }),
  }
  registerMeshIpc(ipcMain, { mesh: () => mesh } as never)
  const sent: MeshConversationFrame[] = []
  const sender = {
    id: 7,
    isDestroyed: () => false,
    once: () => undefined,
    send: (_channel: string, frame: MeshConversationFrame) => sent.push(frame),
  }
  await handlers.get(MESH_CONVERSATION_FOLLOW_CHANNEL)!({ sender }, { followId: 'f1', key: { connectionId: 'c' } })
  emit({ type: 'snapshot', page, generation: 'g' })
  emit({ type: 'event', event: events[0] })
  const [snapshot, live] = sent
  assert.ok(snapshot.type === 'snapshot' && live.type === 'event')
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.page.events)) <= CONVERSATION_WIRE_PAGE_BYTES)
  assert.equal(snapshot.page.events.at(-1)?.seq, 1200)
  assert.equal(snapshot.page.hasMore, true)
  assert.equal(live.event.payload?.output, undefined)
  const earlier = (await handlers.get(MESH_CONVERSATION_EARLIER_CHANNEL)!(
    { sender },
    { key: { connectionId: 'c' }, beforeCursor: 5 },
  )) as { ok: true; page: typeof page }
  assert.deepEqual(earlier.page, snapshot.page)
})
