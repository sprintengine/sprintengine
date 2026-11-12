import { expect, test } from 'vitest'

import { STUDIO_METHODS, STUDIO_TOPICS } from '../../../packages/studio-protocol/src/public'
import { CONVERSATION_IPC_PROTOCOL } from '../../shared/conversation-ipc-protocol'
import type { ConversationService } from '../conversation-service'
import { registerConversationCommandsIpc } from './conversation-commands-ipc'
import { registerConversationIpc } from './conversation-ipc'

// The conversation IPC's channels and the table that says how a client on the
// Studio protocol does what each does, held to each other both ways.

function registeredChannels(): string[] {
  const channels: string[] = []
  const ipcMain = { handle: (channel: string) => channels.push(channel) } as never
  registerConversationIpc(ipcMain, {} as ConversationService)
  const { stop } = registerConversationCommandsIpc(ipcMain, {
    service: { list: async () => ({ cli: 'claude', cwd: '/', commands: [] }) } as never,
  })
  stop()
  return channels
}

test('every conversation channel says how a client on the Studio protocol does the same, and no other is listed', () => {
  const registered = registeredChannels()
  expect(new Set(registered).size).toBe(registered.length)
  expect([...registered].sort()).toEqual(Object.keys(CONVERSATION_IPC_PROTOCOL).sort())
})

test('a channel names the protocol’s own methods and topics, or what it lacks', () => {
  for (const [channel, route] of Object.entries(CONVERSATION_IPC_PROTOCOL)) {
    for (const method of route.methods ?? []) expect(Object.hasOwn(STUDIO_METHODS, method), channel).toBe(true)
    for (const topic of route.topics ?? []) expect(Object.hasOwn(STUDIO_TOPICS, topic), channel).toBe(true)
    // Something does it on the protocol, or something is missing.
    expect((route.methods?.length ?? 0) + (route.topics?.length ?? 0) + route.gaps.length, channel).toBeGreaterThan(0)
    // A planned name is one the protocol lacks: once declared it moves to `methods` or `topics`.
    for (const name of route.planned ?? []) {
      expect(Object.hasOwn(STUDIO_METHODS, name) || Object.hasOwn(STUDIO_TOPICS, name), `${channel}: ${name}`).toBe(
        false,
      )
      expect(route.gaps, channel).toContain('declaration')
    }
    if (route.gaps.includes('declaration')) expect(route.planned?.length, channel).toBeGreaterThan(0)
  }
})
