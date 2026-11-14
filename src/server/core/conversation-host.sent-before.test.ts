import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from '../../main/conversation-runtime'
import { createMockConversationProvider } from '../../main/providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationHeldMessages } from './conversation-host'

// Whether a device's send was carried out before, asked before its uploads
// are staged again: a send in the chat's log by its receipt, or a message
// held here, is found after a restart, which took the live session and every
// upload with it.
test('a send carried out before is found after a restart, by its receipt or as held', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-sent-before-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const mock = createMockConversationProvider()
  // A turn that ends at once.
  const adapter = {
    ...mock,
    sendTurn: (input: Parameters<typeof mock.sendTurn>[0]) => mock.sendTurn({ ...input, message: '/tools' }),
  }
  const held = new Set<string>()
  const heldMessages = { heldBefore: (source: string) => held.has(source) } as unknown as ConversationHeldMessages
  const hostOf = (runtime: ConversationRuntime) =>
    createConversationGatewayHost(
      runtime,
      (id) => (id === key.workspaceId ? workspaceRoot : null),
      () => [{ workspaceRoot, workspaceId: key.workspaceId }],
      () => 'bypass',
      () => null,
      async () => null,
      {},
      { heldMessages },
    )
  const before = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const started = await before.startSession({
      ...key,
      providerId: mock.id,
      modelId: 'mock-model',
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
    const sent = await hostOf(before).command(key, 'phone', 'phone:c1', { kind: 'send', message: 'hello' })
    assert.equal(sent.ok, true, JSON.stringify(sent))
  } finally {
    await before.shutdown()
  }
  // Started again: no session is live, and nothing of the first run is in memory.
  const after = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const host = hostOf(after)
    assert.equal(await host.sentBefore(key, 'phone', 'phone:c1'), true, 'found by its receipt in the chat’s log')
    assert.equal(await host.sentBefore(key, 'phone', 'phone:c2'), false, 'a send never made is not')
    held.add(JSON.stringify(['phone', 'phone:c2']))
    assert.equal(await host.sentBefore(key, 'phone', 'phone:c2'), true, 'a message held here is found as held')
  } finally {
    await after.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
