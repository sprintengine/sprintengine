import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ExtensionHookPoint } from '../../../../packages/extension-sdk/src/hooks'
import type { TerminalSpawnPayload } from '../../../main/terminal-spawn-payload'
import { ownerInvoker } from '../../../main/module-host/extension-invocation'
import type { ExtensionHookOutcome, ExtensionHooks } from './extension-hooks'
import { guardTerminalSpawn } from './launch-hooks'

// The terminal runtime's spawn is the one door a new terminal agent comes
// through: a fresh agent meets `agent.launch.before`, a pty already running or
// a resumed one does not, and a refusal is the spawn's own failure in words
// that name the extension.

function fakeHooks(deny: boolean) {
  const heard: Array<{ point: ExtensionHookPoint; event: Record<string, unknown>; invoker: string }> = []
  const hooks: ExtensionHooks = {
    wants: (point) => point === 'agent.launch.before',
    run: async (point, event, invoker) => {
      heard.push({ point, event: event as Record<string, unknown>, invoker: invoker.label })
      return (
        deny
          ? { kind: 'deny', extensionId: 'acme.guard', displayName: 'Guard', reason: 'not today', failed: false }
          : { kind: 'continue', event }
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

function guard(deny: boolean, liveIds: string[] = []) {
  const { hooks, heard } = fakeHooks(deny)
  const spawned: string[] = []
  const spawn = guardTerminalSpawn<null>({
    spawn: async (_viewer, spawnPayload) => {
      spawned.push(spawnPayload.sessionId)
      return { ok: true, sessionId: spawnPayload.sessionId }
    },
    live: (sessionId) => liveIds.includes(sessionId),
    hooks,
    invokerOf: () => ownerInvoker(null, 'the starter'),
  })
  return { spawn, heard, spawned }
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
