import { testChatDatabase } from '../../tests/studio-database'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { ConversationSendTurnInput } from '../shared/conversation-runtime'
import { createCompanionAgentService } from './companion-agent-service'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// What an extension's companion sends its agent is an extension's input, not a
// person's: every send is marked for the extensions' `agent.prompt.before`,
// which the runtime runs at its one send door (conversation-runtime-hooks.test.ts).
test('a companion’s messages are marked for the prompt hooks as an extension’s companion input', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'companion-hooks-'))
  const mock = createMockConversationProvider()
  const runtime = new ConversationRuntime({
    database: testChatDatabase(),
    // A turn that completes on its own, with no approval to answer.
    adapters: [{ ...mock, sendTurn: (input) => mock.sendTurn({ ...input, message: '/tools' }) }],
    getProviderById: () => undefined,
  })
  const sent: ConversationSendTurnInput[] = []
  const send = runtime.sendTurn.bind(runtime)
  runtime.sendTurn = (input) => {
    sent.push(input)
    return send(input)
  }
  const service = createCompanionAgentService({
    runtime,
    resolveEngineDefaults: () => ({ providerId: 'mock-provider', modelId: 'mock-model' }),
  })
  try {
    const handle = service.attach({
      workspaceId: 'workspace',
      agentId: 'guide',
      name: 'Guide',
      systemPrompt: 'You guide.',
      workspaceRoot,
    })
    await handle.send('What changed?')
    await handle
      .runStructured({ prompt: 'Rate it.', validate: () => ({ ok: true, value: null }) })
      .catch(() => undefined)
    assert.ok(sent.length >= 2)
    for (const input of sent) assert.deepEqual(input.hookAs, { inputKind: 'companion', from: 'extension' })
  } finally {
    service.dispose()
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
