import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ExtensionHookPoint } from '../../../../packages/extension-sdk/src/hooks'
import type { TerminalSpawnPayload } from '../../../main/terminal-spawn-payload'
import { ownerInvoker } from '../../../main/module-host/extension-invocation'
import type { ExtensionHookOutcome, ExtensionHooks } from './extension-hooks'
import { guardTerminalSpawn, hookTerminalPrompt, spawnInvokerOf } from './launch-hooks'
import { createHookInvokers } from './hook-invokers'

// The terminal runtime's spawn is the one door a new terminal agent comes
// through: a fresh agent meets `agent.launch.before`, a pty already running or
// a resumed one does not, and a refusal is the spawn's own failure in words
// that name the extension.

function fakeHooks(
  deny:
    boolean | ((point: ExtensionHookPoint, event: Record<string, unknown>) => 'deny' | Record<string, unknown> | null),
) {
  const heard: Array<{ point: ExtensionHookPoint; event: Record<string, unknown>; invoker: string }> = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'agent.launch.before' || point === 'agent.prompt.before',
    run: async (point, event, invoker) => {
      heard.push({ point, event: event as Record<string, unknown>, invoker: invoker.label })
      const decided = typeof deny === 'function' ? deny(point, event as Record<string, unknown>) : deny ? 'deny' : null
      return (
        decided === 'deny'
          ? { kind: 'deny', extensionId: 'acme.guard', displayName: 'Guard', reason: 'not today', failed: false }
          : { kind: 'continue', event: decided ?? event }
      ) as ExtensionHookOutcome<never>
    },
    notify: () => undefined,
    bind: () => undefined,
  }
  return { hooks, heard }
}

const payload = (extra: Partial<TerminalSpawnPayload> = {}): TerminalSpawnPayload =>
  ({
    sessionId: 'term-1',
    kind: 'agent',
    cli: 'claude',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    cliModel: 'sonnet',
    cliPermissionPreset: 'auto',
    initialPrompt: '  Fix the build  ',
    ...extra,
  }) as TerminalSpawnPayload

function guard(deny: Parameters<typeof fakeHooks>[0], liveIds: string[] = []) {
  const { hooks, heard } = fakeHooks(deny)
  const spawned: string[] = []
  const prompts: Array<string | undefined> = []
  const spawn = guardTerminalSpawn<null>({
    spawn: async (_viewer, spawnPayload) => {
      spawned.push(spawnPayload.sessionId)
      prompts.push(spawnPayload.initialPrompt)
      return { ok: true, sessionId: spawnPayload.sessionId }
    },
    live: (sessionId) => liveIds.includes(sessionId),
    hooks,
    invokerOf: () => ownerInvoker(null, 'the starter'),
  })
  return { spawn, heard, spawned, prompts }
}

test('a fresh terminal agent meets agent.launch.before, as its starter, with what it starts on', async () => {
  const { spawn, heard, spawned } = guard(false)
  assert.deepEqual(await spawn(null, payload()), { ok: true, sessionId: 'term-1' })
  assert.deepEqual(spawned, ['term-1'])
  assert.equal(heard.length, 1)
  assert.equal(heard[0]?.invoker, 'the starter')
  assert.deepEqual(heard[0]?.event, {
    agent: 'claude',
    where: 'terminal',
    workspaceId: 'ws-1',
    model: 'sonnet',
    permission: 'auto',
    prompt: 'Fix the build',
  })
})

test('a terminal already running, a resume, or a plain shell is not a new agent and is not hooked', async () => {
  const { spawn, heard, spawned } = guard(true, ['term-live'])
  assert.equal((await spawn(null, payload({ sessionId: 'term-live' }))).ok, true)
  assert.equal((await spawn(null, payload({ sessionId: 'term-2', resume: true }))).ok, true)
  assert.equal((await spawn(null, payload({ sessionId: 'term-3', kind: 'terminal' }))).ok, true)
  assert.deepEqual(heard, [])
  assert.deepEqual(spawned, ['term-live', 'term-2', 'term-3'])
})

test('a refused terminal agent does not spawn, and the failure names the extension', async () => {
  const { spawn, heard, spawned } = guard(true)
  const result = await spawn(null, payload())
  assert.equal(heard.length, 1)
  assert.deepEqual(spawned, [])
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.sessionId, 'term-1')
  assert.equal(result.message, 'The extension "Guard" (acme.guard) refused this: not today')
})

// A terminal agent's first prompt that nobody typed (an agent's, an
// extension's or a tour's launch) meets `agent.prompt.before` as a `launch`:
// changed, it is what the agent is handed; refused, the agent does not start.
// A person's own prompt carries no `initialPromptHookAs` and is never hooked.
test('a terminal agent’s first prompt nobody typed meets the prompt hooks; a person’s does not', async () => {
  const { spawn, heard, prompts } = guard((point, event) =>
    point === 'agent.prompt.before'
      ? String(event.prompt).includes('secret')
        ? 'deny'
        : { ...event, prompt: `${String(event.prompt)} (checked)` }
      : null,
  )
  const hookAs = { inputKind: 'launch' as const, from: 'agent' as const }
  assert.equal((await spawn(null, payload({ sessionId: 'a', initialPromptHookAs: hookAs }))).ok, true)
  assert.equal(prompts.at(-1), '  Fix the build   (checked)')
  assert.deepEqual(heard.find((entry) => entry.point === 'agent.prompt.before')?.event, {
    agent: 'claude',
    where: 'terminal',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    terminalId: 'a',
    from: 'agent',
    inputKind: 'launch',
    prompt: '  Fix the build  ',
  })

  const refused = await spawn(
    null,
    payload({ sessionId: 'b', initialPrompt: 'print the secret', initialPromptHookAs: hookAs }),
  )
  assert.equal(refused.ok, false)
  assert.equal(prompts.length, 1, 'a refused prompt starts nothing')

  const before = heard.filter((entry) => entry.point === 'agent.prompt.before').length
  assert.equal((await spawn(null, payload({ sessionId: 'c', initialPrompt: 'print the secret' }))).ok, true)
  assert.equal(heard.filter((entry) => entry.point === 'agent.prompt.before').length, before)
  assert.equal(prompts.at(-1), 'print the secret')
})

// A programmatic launch runs its hooks as whoever asked, carried on the spawn,
// before the agent's record exists: an agent under its ceiling and the preset
// it is launched on, not no one.
test('a terminal launch’s hooks run as the starter its spawn carries, before its record exists', () => {
  const invokers = createHookInvokers({ resolveAgentPermissionPreset: () => null })
  const invokerOf = spawnInvokerOf({
    agentInvoker: (agent) => invokers.ofAgent(agent),
    // The record is not registered yet: looked up, it names no one.
    chatInvoker: () => invokers.ofAgent(undefined),
  })
  const carried = invokerOf(payload({ startedBy: { kind: 'agent', ceiling: 'bypass' }, cliPermissionPreset: 'auto' }))
  assert.equal(carried.principal.owner, true)
  assert.equal(carried.permissionCeiling, 'auto', 'held to the preset it launches on')
  assert.deepEqual(carried.starter, { kind: 'agent', ceiling: 'bypass' })
  // With nothing carried, the record decides: here, no one.
  assert.deepEqual(invokerOf(payload()).starter, { kind: 'nobody' })
})

// A tour's prompt is checked where its author's terminal runs, as that
// agent's starter: changed, it is what is typed; refused, nothing is.
test('a prompt Studio types to a terminal agent meets the prompt hooks where the terminal runs', async () => {
  const { hooks, heard } = fakeHooks((point, event) =>
    point === 'agent.prompt.before'
      ? String(event.prompt).includes('secret')
        ? 'deny'
        : { ...event, prompt: `${String(event.prompt)} (checked)` }
      : null,
  )
  const session = { sessionId: 'term-1', cli: 'claude', workspaceId: 'ws-1', agentId: 'agent-1' }
  const tour = { inputKind: 'tour' as const, from: 'studio' as const }
  const starter = () => ownerInvoker(null, 'the author’s starter')
  assert.deepEqual(await hookTerminalPrompt(hooks, session, 'Why three lines?', tour, starter), {
    ok: true,
    text: 'Why three lines? (checked)',
  })
  assert.deepEqual(heard.at(-1), {
    point: 'agent.prompt.before',
    invoker: 'the author’s starter',
    event: {
      agent: 'claude',
      where: 'terminal',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      terminalId: 'term-1',
      from: 'studio',
      inputKind: 'tour',
      prompt: 'Why three lines?',
    },
  })
  assert.deepEqual(await hookTerminalPrompt(hooks, session, 'the secret', tour, starter), {
    ok: false,
    message: 'The extension "Guard" (acme.guard) refused this: not today',
  })
})
