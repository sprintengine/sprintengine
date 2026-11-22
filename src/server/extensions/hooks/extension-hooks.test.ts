import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { studioPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import type { ExtensionHookEvents } from '../../../../packages/extension-sdk/src/hooks'
import { ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { startWorkerHarness, until, type TestExtension, type WorkerHarness } from '../../../../tests/extension-workers'
import { createExtensionHooks, extensionHookRefusal, type ExtensionHooks } from './extension-hooks'

// Extensions' hooks, run by the chain against real worker processes: each
// extension that lists a point, in the order of its install key, as the
// invoker of the action, within its time limit, with `onError` deciding a
// failure. The sample guard in the SDK's examples is one of them.

const GUARD = readFileSync(join(process.cwd(), 'packages/extension-sdk/examples/tool-guard/main.cjs'), 'utf8')
const GUARD_HOOKS = JSON.parse(
  readFileSync(join(process.cwd(), 'packages/extension-sdk/examples/tool-guard/extension.json'), 'utf8'),
).contributes.hooks

const call = (command: string): ExtensionHookEvents['agent.tool.before'] => ({
  agent: 'claude-agent',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  tool: 'Bash',
  input: { command },
  callId: 'toolu_1',
})

/** A worker whose `agent.tool.before` runs `body` (with `event` and `studio` in scope). */
const toolHook = (body: string, activate = '') => `
exports.activate = async (studio) => {
  ${activate}
  studio.registerHooks({ 'agent.tool.before': async (event) => { ${body} } })
}
`

const device: ExtensionInvoker = {
  principal: studioPrincipal({ owner: false, permissions: ['extension:read'] }),
  permissionCeiling: 'auto',
  label: 'the device "android-phone"',
}

let harness: WorkerHarness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

function start(extensions: TestExtension[], options: Parameters<typeof startWorkerHarness>[1] = {}): ExtensionHooks {
  harness = startWorkerHarness(extensions, options)
  const hooks = createExtensionHooks()
  hooks.bind(harness.workers)
  return hooks
}

test('a point no extension lists is not wanted, and runs nothing', async () => {
  const hooks = start([{ id: 'quiet', main: toolHook('return undefined') }])
  assert.equal(hooks.wants('agent.tool.before'), false)
  assert.equal(createExtensionHooks().wants('agent.tool.before'), false, 'no workers bound: nothing listed')
  assert.deepEqual(await hooks.run('agent.tool.before', call('ls'), ownerInvoker()), {
    kind: 'continue',
    event: call('ls'),
  })
})

test('the sample guard refuses rm -rf, naming itself, and lets anything else through', async () => {
  const hooks = start([{ id: 'tool-guard', name: 'Tool guard', main: GUARD, hooks: GUARD_HOOKS }])
  assert.equal(hooks.wants('agent.tool.before'), true)
  for (const command of ['rm -rf build', 'cd app && rm -fr dist', 'rm -r -f node_modules', 'rm --recursive --force x']) {
    const outcome = await hooks.run('agent.tool.before', call(command), ownerInvoker())
    assert.equal(outcome.kind, 'deny', command)
    if (outcome.kind !== 'deny') continue
    assert.equal(outcome.extensionId, 'local.tool-guard')
    assert.equal(outcome.failed, false)
    assert.match(extensionHookRefusal(outcome), /^The extension "Tool guard" \(local\.tool-guard\) refused this: it deletes files recursively and by force/u)
  }
  for (const command of ['rm build/out.txt', 'ls -rf', 'git rm -r src']) {
    const outcome = await hooks.run('agent.tool.before', call(command), ownerInvoker())
    assert.equal(outcome.kind, 'continue', command)
  }
})

test('the sample guard’s after hook writes each finished call to its log, and nothing waits for it', async () => {
  const hooks = start([{ id: 'tool-guard', name: 'Tool guard', main: GUARD, hooks: GUARD_HOOKS }])
  hooks.notify('agent.tool.after', { ...call('ls'), output: 'a\nb', failed: false }, ownerInvoker())
  hooks.notify('agent.tool.after', { ...call('false'), output: 'exit 1', failed: true }, ownerInvoker())
  const log = join(harness!.logDir, 'local.tool-guard.log')
  const read = () => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }
  await until(() => read().includes('failed: Bash in ws-1/agent-1'), 10_000, 'the after hook’s log lines')
  assert.match(read(), /finished: Bash in ws-1\/agent-1/u)
})

test('a hook changes the fields its point allows, and a change to any other field is ignored', async () => {
  const hooks = start([
    {
      id: 'rewriter',
      main: toolHook(
        `return event.input.command === 'tool' ? { change: { tool: 'Write' } } : { change: { input: { command: event.input.command + ' --dry-run' } } }`,
      ),
      hooks: [{ point: 'agent.tool.before' }],
    },
  ])
  assert.deepEqual(await hooks.run('agent.tool.before', call('make deploy'), ownerInvoker()), {
    kind: 'continue',
    event: call('make deploy --dry-run'),
  })
  assert.deepEqual(await hooks.run('agent.tool.before', call('tool'), ownerInvoker()), {
    kind: 'continue',
    event: call('tool'),
  })
})

test('extensions run in the order of their install keys, each seeing the last one’s change, and a refusal stops the rest', async () => {
  const hooks = start([
    // Listed out of order: the install keys decide.
    {
      id: 'b-second',
      name: 'Second',
      main: toolHook(`return event.input.command.endsWith('!') ? { deny: 'saw ' + event.input.command } : undefined`),
      hooks: [{ point: 'agent.tool.before' }],
    },
    {
      id: 'a-first',
      name: 'First',
      main: toolHook(`return { change: { input: { command: event.input.command + '!' } } }`),
      hooks: [{ point: 'agent.tool.before' }],
    },
    {
      id: 'c-third',
      name: 'Third',
      main: toolHook('return undefined'),
      hooks: [{ point: 'agent.tool.before' }],
    },
  ])
  const outcome = await hooks.run('agent.tool.before', call('echo hi'), ownerInvoker())
  assert.deepEqual(outcome, {
    kind: 'deny',
    extensionId: 'local.b-second',
    displayName: 'Second',
    reason: 'saw echo hi!',
    failed: false,
  })
  assert.equal(harness!.workers.status('local.c-third')?.state, 'idle', 'the third was never started')
})

for (const onError of ['pass', 'deny'] as const) {
  test(`a hook that hangs is given up on at its time limit, and onError "${onError}" decides`, async () => {
    const hooks = start([
      {
        id: 'hangs',
        name: 'Hangs',
        main: toolHook('await new Promise(() => undefined)'),
        hooks: [{ point: 'agent.tool.before', onError }],
      },
    ])
    // Started first, so the time measured is the hook's alone.
    await harness!.workers.startForHook('local.hangs')
    const began = Date.now()
    const outcome = await hooks.run('agent.tool.before', call('ls'), ownerInvoker())
    const took = Date.now() - began
    assert.ok(took >= 1_900 && took < 4_000, `gave up after ${took}ms`)
    if (onError === 'pass') assert.deepEqual(outcome, { kind: 'continue', event: call('ls') })
    else {
      assert.equal(outcome.kind, 'deny')
      assert.equal(outcome.kind === 'deny' && outcome.failed, true)
      assert.match(outcome.kind === 'deny' ? outcome.reason : '', /^its hook failed, and it refuses when it fails: .*did not answer within 2s/u)
    }
  })
}

test('a hook that throws, or whose worker crashes, fails by its onError', async () => {
  const hooks = start([
    {
      id: 'a-throws',
      main: toolHook(`throw new Error('broken')`),
      hooks: [{ point: 'agent.tool.before' }],
    },
    {
      id: 'b-crashes',
      name: 'Crashes',
      main: toolHook(`process.exit(3)`),
      hooks: [{ point: 'agent.tool.before', onError: 'deny' }],
    },
  ])
  const outcome = await hooks.run('agent.tool.before', call('ls'), ownerInvoker())
  assert.equal(outcome.kind, 'deny')
  if (outcome.kind !== 'deny') return
  assert.equal(outcome.extensionId, 'local.b-crashes', 'the throw passed; the crash refused')
  assert.equal(outcome.failed, true)
})

test('a worker’s start is not counted against its hook’s time limit', async () => {
  const hooks = start([
    {
      id: 'slow-start',
      // Activates in 1.5 s, then answers in 1 s: 2.5 s in all, inside each limit.
      main: toolHook(
        `await new Promise((resolve) => setTimeout(resolve, 1000)); return { deny: 'decided' }`,
        'await new Promise((resolve) => setTimeout(resolve, 1500))',
      ),
      hooks: [{ point: 'agent.tool.before' }],
    },
  ])
  assert.equal(harness!.workers.status('local.slow-start')?.state, 'idle')
  const outcome = await hooks.run('agent.tool.before', call('ls'), ownerInvoker())
  assert.equal(outcome.kind === 'deny' && outcome.reason, 'decided')
})

test('a hook runs as the action’s invoker: a device without the permission is refused what the person is not', async () => {
  const hooks = start([
    {
      id: 'reads-git',
      permissions: ['workspace:read'],
      main: toolHook(`
        const info = await studio.getWorkspaceGitInfo(event.workspaceId)
        return info.ok ? undefined : { deny: 'git info refused: ' + info.code }
      `),
      hooks: [{ point: 'agent.tool.before' }],
    },
  ])
  assert.deepEqual(await hooks.run('agent.tool.before', call('ls'), ownerInvoker()), {
    kind: 'continue',
    event: call('ls'),
  })
  const asDevice = await hooks.run('agent.tool.before', call('ls'), device)
  assert.equal(asDevice.kind === 'deny' && asDevice.reason, 'git info refused: not_permitted')
})

test('a hook the worker did not register, or one extension.json does not list, is refused at registration', async () => {
  const hooks = start([
    {
      id: 'unregistered',
      main: `exports.activate = () => undefined`,
      hooks: [{ point: 'agent.tool.before', onError: 'deny' }],
    },
    {
      id: 'unlisted',
      main: `exports.activate = (studio) => studio.registerHooks({ 'editor.save.before': () => undefined })`,
      hooks: [{ point: 'agent.tool.after' }],
    },
  ], { maxRestarts: 0, backoffMs: [10] })
  const outcome = await hooks.run('agent.tool.before', call('ls'), ownerInvoker())
  assert.match(outcome.kind === 'deny' ? outcome.reason : '', /registered no hook for "agent\.tool\.before"/u)
  // The worker whose registration was refused did not start.
  await assert.rejects(harness!.workers.startForHook('local.unlisted'), /not listed in its extension\.json/u)
})

test('an agent.tool.before round trip to a running worker takes a few milliseconds', async () => {
  const hooks = start([{ id: 'tool-guard', name: 'Tool guard', main: GUARD, hooks: GUARD_HOOKS }])
  await harness!.workers.startForHook('local.tool-guard')
  for (let warm = 0; warm < 20; warm += 1) await hooks.run('agent.tool.before', call('ls'), ownerInvoker())
  const samples: number[] = []
  for (let round = 0; round < 200; round += 1) {
    const began = process.hrtime.bigint()
    await hooks.run('agent.tool.before', call(`ls ${round}`), ownerInvoker())
    samples.push(Number(process.hrtime.bigint() - began) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const median = samples[100]!
  const p95 = samples[190]!
  console.info(`agent.tool.before round trip: median ${median.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms`)
  assert.ok(median < 50, `median ${median}ms`)
})
