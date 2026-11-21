import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { ownerInvoker, runAsInvoker } from '../../../main/module-host/extension-invocation'
import type { McpToolResult } from '../../../shared/modules/mcp-tools'
import {
  WORKER_CALL_TIMEOUT_MS,
  WORKER_IDLE_REAP_MS,
  WORKER_MAX_ACTIVE,
  WORKER_MAX_BACKGROUND,
  WORKER_MAX_RESTARTS,
  WORKER_READY_TIMEOUT_MS,
  WORKER_RESTART_BACKOFF_MS,
  WORKER_SHUTDOWN_GRACE_MS,
} from './worker-protocol'
import {
  alive,
  startWorkerHarness,
  until,
  type TestExtension,
  type WorkerHarness,
} from '../../../../tests/extension-workers'

// When a worker process runs, and what happens when it stops: activation on
// demand, the idle reap, the caps, restarts after a crash and the errored
// state, stopping it when it is switched off, uninstalled or changed, and its
// MCP tools reaching it.

const PING = `exports.activate = (studio) => studio.registerMethods({
  ping: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: process.pid }) },
  wait: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => new Promise(() => {}) },
})\n`

const worker = (id: string, extra: Partial<TestExtension> = {}): TestExtension => ({ id, main: PING, ...extra })

let harness: WorkerHarness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

function ping(id: string, method = 'ping') {
  return harness!.load.kernel.callModuleMethod({
    moduleId: `local.${id}`,
    method,
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
}

async function pid(id: string): Promise<number> {
  const answer = await ping(id)
  assert.ok(answer.ok && answer.answer.ok, JSON.stringify(answer))
  return answer.answer.result as number
}

test('the supervision numbers', () => {
  assert.equal(WORKER_READY_TIMEOUT_MS, 10_000)
  assert.equal(WORKER_CALL_TIMEOUT_MS, 30_000)
  assert.equal(WORKER_IDLE_REAP_MS, 5 * 60_000)
  assert.equal(WORKER_MAX_ACTIVE, 5)
  assert.equal(WORKER_MAX_BACKGROUND, 16)
  assert.deepEqual(WORKER_RESTART_BACKOFF_MS, [500, 2000, 5000])
  assert.equal(WORKER_MAX_RESTARTS, 3)
  assert.equal(WORKER_SHUTDOWN_GRACE_MS, 2_000)
})

test('an on-demand worker starts at its first call, in a process of its own, and is reaped when idle', async () => {
  harness = startWorkerHarness([worker('lazy')], { idleReapMs: 1_000 })
  assert.equal(harness.workers.status('local.lazy')?.state, 'idle', 'nothing has used it yet')
  const first = await pid('lazy')
  assert.notEqual(first, process.pid)
  assert.ok(alive(first))
  assert.equal(await pid('lazy'), first, 'one process serves every call')
  await harness.workers.reapIdle(Date.now())
  assert.equal(harness.workers.status('local.lazy')?.state, 'running', 'not yet idle long enough')
  await harness.workers.reapIdle(Date.now() + 1_000)
  assert.equal(harness.workers.status('local.lazy')?.state, 'idle')
  await until(() => !alive(first), 5_000, 'the reaped process to exit')
  const second = await pid('lazy')
  assert.notEqual(second, first, 'the next call starts it again')
})

test('at most the cap of on-demand workers run; one more waits, and starts when one stops', async () => {
  harness = startWorkerHarness([worker('one'), worker('two')], { maxActive: 1, idleReapMs: 0 })
  await pid('one')
  const second = ping('two')
  await until(() => harness!.workers.status('local.two')?.state === 'waiting', 5_000, 'the second to wait')
  assert.match(harness.workers.status('local.two')?.message ?? '', /1 extension workers are running/)
  await harness.workers.reapIdle(Date.now() + 1)
  const answered = await second
  assert.ok(answered.ok && answered.answer.ok, 'it started once the first was reaped')
})

test('background workers start when switched on, are not reaped, and past the cap the newest waits and says why', async () => {
  harness = startWorkerHarness([worker('early', { background: true }), worker('late', { background: true })], {
    maxBackground: 1,
    idleReapMs: 0,
  })
  await until(() => harness!.workers.status('local.early')?.state === 'running', 10_000, 'the first to start')
  await until(() => harness!.workers.status('local.late')?.state === 'waiting', 5_000, 'the second to wait')
  assert.match(
    harness.workers.status('local.late')?.message ?? '',
    /1 extensions already run in the background, the most Studio runs at once/,
  )
  await harness.workers.reapIdle(Date.now() + 60_000)
  assert.equal(harness.workers.status('local.early')?.state, 'running', 'a background worker is never reaped')
  // Switching the first off frees its place.
  await harness.load.applyEnablement({ 'local.early': false }, { liveModuleIds: ['local.early', 'local.late'] })
  await until(() => harness!.workers.status('local.late')?.state === 'running', 10_000, 'the second to start')
})

test('a crash restarts it after each wait in turn; past three restarts it is errored, in its status and the bell', async () => {
  harness = startWorkerHarness([worker('fragile')], { backoffMs: [30, 60, 90] })
  const pids = [await pid('fragile')]
  for (let crash = 1; crash <= 3; crash++) {
    process.kill(pids.at(-1)!, 'SIGKILL')
    await until(() => harness!.workers.status('local.fragile')?.state === 'restarting', 5_000, `restart ${crash}`)
    await until(() => harness!.workers.status('local.fragile')?.state === 'running', 10_000, `run ${crash}`)
    pids.push(harness.workers.status('local.fragile')!.pid!)
  }
  assert.equal(new Set(pids).size, 4)
  process.kill(pids.at(-1)!, 'SIGKILL')
  await until(() => harness!.workers.status('local.fragile')?.state === 'errored', 5_000, 'errored')
  assert.match(harness.workers.status('local.fragile')?.message ?? '', /crashed 4 times/)
  assert.equal(harness.bell.length, 1)
  assert.equal(harness.bell[0]!.input.severity, 'error')
  const refused = await ping('fragile')
  assert.equal(!refused.ok && refused.code, 'extension_unavailable')
  // The waits, in order, as its log says.
  const log = readFileSync(join(harness.logDir, 'local.fragile.log'), 'utf8')
  assert.deepEqual(
    [...log.matchAll(/restart (\d) in (\d+)ms/gu)].map((match) => [match[1], match[2]]),
    [
      ['1', '30'],
      ['2', '60'],
      ['3', '90'],
    ],
  )
})

test('a worker that never says it is ready is stopped at the ready timeout, and counts as a crash', async () => {
  harness = startWorkerHarness([worker('stuck', { main: 'exports.activate = () => new Promise(() => {})\n' })], {
    readyTimeoutMs: 200,
    backoffMs: [10],
    maxRestarts: 1,
  })
  const answer = await ping('stuck')
  assert.equal(!answer.ok && answer.code, 'extension_unavailable')
  assert.match(!answer.ok ? answer.message : '', /did not start within 0s/)
  assert.equal(harness.workers.status('local.stuck')?.state, 'errored')
})

test('a call that is not answered in time fails with words that say so', async () => {
  harness = startWorkerHarness([worker('slow')], { callTimeoutMs: 200 })
  await assert.rejects(ping('slow', 'wait'), /did not answer within 0s/)
})

test('switching it off stops it at once, with no restart, and a call in flight ends with why', async () => {
  harness = startWorkerHarness([worker('switch')])
  const running = await pid('switch')
  const inFlight = ping('switch', 'wait')
  // Heard below; handled now, so its rejection is not taken for an unhandled one.
  inFlight.catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 100))
  await harness.load.applyEnablement({ 'local.switch': false }, { liveModuleIds: ['local.switch'] })
  await assert.rejects(inFlight, /was switched off, so its worker stopped/)
  await until(() => !alive(running), 5_000, 'its process to exit')
  assert.equal(harness.workers.serves('local.switch'), false)
  const refused = await ping('switch')
  assert.equal(!refused.ok && refused.code, 'extension_unavailable')
})

test('uninstalling it, or a changed approval, stops it without a restart', async () => {
  harness = startWorkerHarness([worker('gone'), worker('changed')])
  const gone = await pid('gone')
  const changed = await pid('changed')
  harness.approvals.delete('local.gone')
  harness.approvals.set('local.changed', { fingerprint: 'sha256-something-else' })
  harness.workers.reconcile()
  await until(() => !alive(gone) && !alive(changed), 5_000, 'both processes to exit')
  assert.equal(harness.workers.status('local.gone')?.state, 'stopped')
  assert.match(harness.workers.status('local.gone')?.message ?? '', /no longer approved/)
  assert.equal(harness.workers.status('local.changed')?.state, 'stopped')
  assert.match(harness.workers.status('local.changed')?.message ?? '', /changed since its worker started/)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(harness.workers.status('local.changed')?.state, 'stopped', 'and it is not restarted')
})

test('its MCP tools are on the gateway before it runs, and a call reaches its worker as the caller', async () => {
  const main = `exports.activate = (studio) => studio.registerMcpTools([{
    name: 'echo_words',
    description: 'from code',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args, context) => ({ content: [{ type: 'text', text: String(args.text).split(' ').length + ' words' }], structuredContent: { pid: process.pid, kind: context.metadata.kind } }),
  }])\n`
  harness = startWorkerHarness([
    {
      id: 'echo',
      main,
      permissions: ['tools:contribute'],
      mcpTools: [
        {
          name: 'echo_words',
          description: 'Count the words.',
          access: 'read',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
    },
  ])
  const listed = () =>
    harness!.load.kernel.mcpToolRegistrations().find((tool) => tool.registration.name === 'echo_words')
  const before = listed()
  assert.ok(before, 'advertised before its worker runs')
  assert.equal(before.moduleId, 'local.echo')
  assert.equal(before.registration.description, 'Count the words.', 'described as extension.json describes it')
  assert.equal(before.registration.mutates, false)
  assert.deepEqual(before.registration.inputSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  })
  assert.equal(harness.workers.status('local.echo')?.state, 'idle')

  const result = (await runAsInvoker(ownerInvoker('auto', 'the agent'), () =>
    before.registration.handler({ text: 'one two three' }, { metadata: { kind: 'studio-agent', verified: true } }),
  )) as McpToolResult
  assert.deepEqual(result.content, [{ type: 'text', text: '3 words' }])
  assert.equal((result.structuredContent as { kind: string }).kind, 'studio-agent')
  assert.notEqual((result.structuredContent as { pid: number }).pid, process.pid)
})

test('a worker that serves a tool its extension.json does not declare does not start', async () => {
  const main = `exports.activate = (studio) => studio.registerMcpTools([{ name: 'secret_tool', description: 'x', inputSchema: { type: 'object' }, handler: async () => ({ content: [] }) }])\n`
  harness = startWorkerHarness(
    [
      {
        id: 'sneaky',
        main,
        permissions: ['tools:contribute'],
        mcpTools: [{ name: 'open_tool', description: 'Open.', access: 'read', inputSchema: { type: 'object' } }],
      },
    ],
    { maxRestarts: 0 },
  )
  const tool = harness.load.kernel.mcpToolRegistrations().find((entry) => entry.registration.name === 'open_tool')!
  const result = await tool.registration.handler({}, undefined)
  assert.equal(result.isError, true)
  assert.match(result.content[0]!.type === 'text' ? result.content[0]!.text : '', /not declared in its extension.json/)
})

test('a background worker whose folder was removed or changed stops, stays stopped, and its tools leave the gateway', async () => {
  const tools = (id: string) => [
    { name: `${id}_ping`, description: 'Ping.', access: 'read' as const, inputSchema: { type: 'object' } },
  ]
  harness = startWorkerHarness([
    worker('removed', { background: true, permissions: ['tools:contribute'], mcpTools: tools('removed') }),
    worker('changed', { background: true, permissions: ['tools:contribute'], mcpTools: tools('changed') }),
  ])
  await until(
    () => ['local.removed', 'local.changed'].every((id) => harness!.workers.status(id)?.state === 'running'),
    10_000,
    'both to start',
  )
  const pids = ['local.removed', 'local.changed'].map((id) => harness!.workers.status(id)!.pid!)
  const listed = () =>
    harness!.load.kernel
      .mcpToolRegistrations()
      .map((tool) => tool.registration.name)
      .sort()
  assert.deepEqual(listed(), ['changed_ping', 'removed_ping'])
  const changesBefore = harness.toolsChanged()

  // Their approvals stand as they were: only what is installed changed.
  harness.installed.delete('local.removed')
  harness.installed.set('local.changed', { runnable: false, fingerprint: null })
  harness.workers.reconcile()
  await until(() => pids.every((pid) => !alive(pid)), 5_000, 'both processes to exit')
  assert.match(harness.workers.status('local.removed')?.message ?? '', /no longer installed/)
  assert.match(harness.workers.status('local.changed')?.message ?? '', /waits for your approval/)
  assert.deepEqual(listed(), [], 'their tools leave the gateway')
  assert.ok(harness.toolsChanged() > changesBefore, 'MCP clients are told')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(harness.workers.status('local.removed')?.state, 'stopped', 'and neither is restarted')
  assert.equal(harness.workers.status('local.changed')?.state, 'stopped')
})

test('the bell row for a worker that keeps crashing names no place on this disk; its log keeps the whole of it', async () => {
  const main =
    'exports.activate = () => { throw new Error("Cannot find module \'/Users/dev/.sprintengine/extensions/local.leaky/dist/missing.cjs\'") }\n'
  harness = startWorkerHarness([worker('leaky', { main })], { maxRestarts: 0 })
  const answer = await ping('leaky')
  assert.equal(!answer.ok && answer.code, 'extension_unavailable')
  assert.equal(harness.bell.length, 1)
  const body = harness.bell[0]!.input.body ?? ''
  assert.doesNotMatch(body, /\/Users\//)
  assert.match(body, /crashed once\. Its log/)
  assert.match(
    readFileSync(join(harness.logDir, 'local.leaky.log'), 'utf8'),
    /\/Users\/dev\/\.sprintengine\/extensions\/local\.leaky/,
  )
})

test('a call during an idle stop waits for the old process to finish, and the cap still counts it once', async () => {
  // Its shutdown hook takes a while: the window a racing start would land in.
  const slowToStop = PING.replace(
    'exports.activate = (studio) => studio.registerMethods(',
    'exports.activate = (studio) => (studio.onShutdown(() => new Promise((resolve) => setTimeout(resolve, 400))), studio.registerMethods)(',
  )
  harness = startWorkerHarness([worker('first', { main: slowToStop }), worker('second')], {
    maxActive: 1,
    idleReapMs: 0,
  })
  const before = await pid('first')
  const reaping = harness.workers.reapIdle(Date.now() + 1)
  const again = pid('first')
  const [, after] = await Promise.all([reaping, again])
  assert.notEqual(after, before)
  const log = readFileSync(join(harness.logDir, 'local.first.log'), 'utf8')
  assert.ok(
    log.indexOf('worker stopped') < log.lastIndexOf(`worker started (pid ${after})`),
    'the new process started only once the old one had stopped',
  )
  // One place, and the restarted worker holds it: the second waits.
  const second = ping('second')
  await until(() => harness!.workers.status('local.second')?.state === 'waiting', 5_000, 'the second to wait')
  await harness.workers.reapIdle(Date.now() + 1)
  const answered = await second
  assert.ok(answered.ok && answered.answer.ok)
})

test('a worker that stops between starting and taking a call answers that it is unavailable, not a crash', async () => {
  harness = startWorkerHarness([
    worker('brief', {
      main: `${PING}exports.activate = ((activate) => (studio) => {
        activate(studio)
        studio.registerMcpTools([{ name: 'brief_ping', description: 'x', inputSchema: { type: 'object' }, handler: async () => ({ content: [] }) }])
      })(exports.activate)\n`,
      permissions: ['tools:contribute'],
      mcpTools: [{ name: 'brief_ping', description: 'Ping.', access: 'read', inputSchema: { type: 'object' } }],
    }),
  ])
  const workers = harness.workers as unknown as { ensure: (id: string) => Promise<{ session: unknown }> }
  const started = workers.ensure.bind(harness.workers)
  // As if it exited the moment it was ready.
  workers.ensure = async (id) => Object.assign(await started(id), { session: null })
  const answer = await ping('brief')
  assert.equal(!answer.ok && answer.code, 'extension_unavailable')
  const tool = harness.load.kernel.mcpToolRegistrations().find((entry) => entry.registration.name === 'brief_ping')!
  const result = await tool.registration.handler({}, undefined)
  assert.match(JSON.stringify(result.content), /extension_unavailable/)
})
