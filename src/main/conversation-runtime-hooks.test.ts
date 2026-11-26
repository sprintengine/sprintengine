import { testChatDatabase } from '../../tests/studio-database'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { ExtensionHookPoint } from '../../packages/extension-sdk/src/hooks'
import type { ExtensionHookOutcome, ExtensionHooks } from '../server/extensions/hooks/extension-hooks'
import { ConversationRuntime } from './conversation-runtime'
import { ownerInvoker, runAsInvoker } from './module-host/extension-invocation'
import { createMockConversationProvider, type MockAdapterTurnInput } from './providers/mock-conversation-provider'

// The runtime is the one door for the extensions' launch and prompt hooks in a
// chat: a chat's very first session meets `agent.launch.before` (a chat
// resumed does not), and a message nobody typed meets `agent.prompt.before`
// when its sender says what it is (`hookAs`). A person's message never does.

type Heard = { point: ExtensionHookPoint; event: Record<string, unknown>; invoker: string }

function fakeHooks(
  decide: (point: ExtensionHookPoint, event: Record<string, unknown>) => 'deny' | Record<string, unknown> | null,
) {
  const heard: Heard[] = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'agent.launch.before' || point === 'agent.prompt.before',
    run: async (point, event, invoker) => {
      const seen = event as Record<string, unknown>
      heard.push({ point, event: seen, invoker: invoker.label })
      const decided = decide(point, seen)
      return (
        decided === 'deny'
          ? { kind: 'deny', extensionId: 'acme.guard', displayName: 'Guard', reason: 'not here', failed: false }
          : { kind: 'continue', event: decided ?? event }
      ) as ExtensionHookOutcome<never>
    },
    notify: () => undefined,
    bind: () => undefined,
  }
  return { hooks, heard }
}

async function harness(decide: Parameters<typeof fakeHooks>[0]) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-hooks-runtime-'))
  const turns: MockAdapterTurnInput[] = []
  const mock = createMockConversationProvider()
  const { hooks, heard } = fakeHooks(decide)
  const runtime = new ConversationRuntime({
    database: testChatDatabase(),
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          turns.push(input)
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
    extensionHooks: hooks,
    chatInvoker: () => ownerInvoker(null, 'the chat’s starter'),
    starterInvoker: (starter) => ownerInvoker(null, `starter ${starter.kind}`),
  })
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const start = (extra: { openingPrompt?: string } = {}) =>
    runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model', ...extra })
  const done = async () => {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
  return { runtime, heard, turns, start, done }
}

test('a new chat refused by agent.launch.before does not start, and says which extension refused', async () => {
  const { heard, start, done } = await harness((point) => (point === 'agent.launch.before' ? 'deny' : null))
  try {
    const started = await start()
    assert.equal(started.ok, false)
    assert.ok(!started.ok)
    assert.equal(started.message, 'The extension "Guard" (acme.guard) refused this: not here')
    assert.equal(heard.length, 1)
    assert.equal(heard[0]?.invoker, 'the chat’s starter')
    assert.deepEqual(heard[0]?.event, {
      agent: 'mock-provider',
      where: 'chat',
      workspaceId: 'workspace',
      model: 'mock-model',
      permission: null,
      prompt: null,
    })
  } finally {
    await done()
  }
})

test('a chat started again on its own transcript is not a new agent, and is not hooked', async () => {
  const { runtime, heard, start, done } = await harness(() => null)
  try {
    const first = await start()
    assert.ok(first.ok)
    assert.equal((await runtime.sendTurn({ sessionId: first.session.sessionId, message: 'hello' })).ok, true)
    assert.equal((await runtime.stopSession({ sessionId: first.session.sessionId })).ok, true)
    assert.equal(heard.filter((entry) => entry.point === 'agent.launch.before').length, 1)

    const again = await start()
    assert.ok(again.ok)
    assert.equal(
      heard.filter((entry) => entry.point === 'agent.launch.before').length,
      1,
      'a resumed chat is not hooked',
    )
  } finally {
    await done()
  }
})

test('a message nobody typed meets agent.prompt.before; what a person types never does', async () => {
  const { runtime, heard, turns, start, done } = await harness((point, event) =>
    point === 'agent.prompt.before'
      ? event.prompt === 'rm everything'
        ? 'deny'
        : { ...event, prompt: `${String(event.prompt)} (checked)` }
      : null,
  )
  try {
    const started = await start()
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    heard.length = 0

    // The person's own words go as typed, past every hook.
    assert.equal((await runtime.sendTurn({ sessionId, message: 'rm everything' })).ok, true)
    assert.equal(turns.at(-1)?.message, 'rm everything')
    assert.equal(heard.length, 0)

    // A companion's message is hooked and sent as changed, as the chat's starter.
    const sent = await runtime.sendTurn({
      sessionId,
      message: 'Review the diff',
      hookAs: { inputKind: 'companion', from: 'extension' },
    })
    assert.equal(sent.ok, true)
    assert.equal(turns.at(-1)?.message, 'Review the diff (checked)')
    assert.deepEqual(heard.at(-1), {
      point: 'agent.prompt.before',
      invoker: 'the chat’s starter',
      event: {
        agent: 'mock-provider',
        where: 'chat',
        workspaceId: 'workspace',
        agentId: 'agent',
        terminalId: null,
        from: 'extension',
        inputKind: 'companion',
        prompt: 'Review the diff',
      },
    })

    // A send naming its starter runs as that starter; one inside an
    // extension's call runs as that call's invoker.
    await runtime.sendTurn({
      sessionId,
      message: 'next',
      hookAs: { inputKind: 'recovery', from: 'studio', starter: { kind: 'nobody' } },
    })
    assert.equal(heard.at(-1)?.invoker, 'starter nobody')
    await runAsInvoker(ownerInvoker(null, 'the extension’s caller'), () =>
      runtime.sendTurn({ sessionId, message: 'mine', hookAs: { inputKind: 'send', from: 'extension' } }),
    )
    assert.equal(heard.at(-1)?.invoker, 'the extension’s caller')

    // A refusal is the send's own, and nothing reaches the agent.
    const before = turns.length
    const refused = await runtime.sendTurn({
      sessionId,
      message: 'rm everything',
      hookAs: { inputKind: 'launch', from: 'agent' },
    })
    assert.deepEqual(refused, {
      ok: false,
      code: 'refused_by_extension',
      message: 'The extension "Guard" (acme.guard) refused this: not here',
    })
    assert.equal(turns.length, before)
  } finally {
    await done()
  }
})

test('a new chat’s launch hook sees the first message it is about to be sent', async () => {
  const { heard, start, done } = await harness(() => null)
  try {
    const started = await start({ openingPrompt: '  Fix the build  ' })
    assert.ok(started.ok)
    assert.equal(heard.find((entry) => entry.point === 'agent.launch.before')?.event.prompt, 'Fix the build')
  } finally {
    await done()
  }
})

// A retry of a send already carried out is answered from its receipt: the
// extensions' hooks are not run again for it.
test('a retried send is answered from its receipt without running the prompt hooks again', async () => {
  const { runtime, heard, turns, start, done } = await harness((point, event) =>
    point === 'agent.prompt.before' ? { ...event, prompt: `${String(event.prompt)} (checked)` } : null,
  )
  try {
    const started = await start()
    assert.ok(started.ok)
    const send = {
      sessionId: started.session.sessionId,
      commandId: 'cmd-retried',
      message: 'Review it',
      hookAs: { inputKind: 'send' as const, from: 'extension' as const },
    }
    assert.equal((await runtime.sendTurn(send)).ok, true)
    assert.equal((await runtime.sendTurn(send)).ok, true)
    assert.equal(heard.filter((entry) => entry.point === 'agent.prompt.before').length, 1)
    assert.equal(turns.filter((turn) => turn.message === 'Review it (checked)').length, 1)
  } finally {
    await done()
  }
})
