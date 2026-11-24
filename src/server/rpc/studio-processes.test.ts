import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioAgentProcess, StudioProcessesMethodMap } from '../../../packages/studio-protocol/src/public'
import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/scopes'
import type { StudioProcesses } from '../processes/agent-process-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `processes.*` over the owner socket: the capability and the two methods, as
// a client reads them. The domain behind them is a stub; what it decides is
// agent-process-domain.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ROW: StudioAgentProcess = {
  id: '4242-1700000000',
  pid: 4242,
  startedAt: 1_700_000_000_000,
  name: 'Vite dev server',
  kind: 'server',
  command: 'node /Users/dev/app/node_modules/.bin/vite',
  ports: [5173],
  memoryBytes: 1024,
  childCount: 1,
  state: 'left-behind',
  agentRunning: false,
  workspaceId: 'ws-1',
  agentId: 'agent-1',
}

function stubProcesses() {
  const asked: string[][] = []
  const stub: StudioProcesses = {
    list: async () => ({ processes: [ROW], scannedAt: 1 }),
    stop: async (ids) => {
      asked.push([...ids])
      return { results: ids.map((id) => ({ id, outcome: id === ROW.id ? 'stopped' : 'gone' })) }
    },
  }
  return { stub, asked }
}

async function ownerOver(processes?: StudioProcesses) {
  const started = await startTestServer(processes ? { processes } : {})
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = `r${++seq}`
    owner.send({ t: 'req', id, method, params })
    return owner.next((frame) => frame.t === 'res' && frame.id === id)
  }
  return { started, owner, welcome, request }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? frame.error?.code : null

test('a Studio given the processes domain advertises it, and one without answers unavailable', async () => {
  const withThem = await ownerOver(stubProcesses().stub)
  assert.equal(withThem.welcome.t === 'welcome' && withThem.welcome.capabilities.includes('processes'), true)
  const without = await ownerOver()
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('processes'), false)
  assert.equal(codeOf(await without.request('processes.list', {})), 'unavailable')
})

test('an owner lists and stops by row id, and malformed stops are refused', async () => {
  const { stub, asked } = stubProcesses()
  const { request } = await ownerOver(stub)
  const listed = await request('processes.list', {})
  const result =
    listed.t === 'res' && listed.ok ? (listed.result as StudioProcessesMethodMap['processes.list']['result']) : null
  assert.deepEqual(result?.processes, [ROW])

  const stopped = await request('processes.stop', { ids: [ROW.id, '7-1'], commandId: 'c1' })
  assert.deepEqual(stopped.t === 'res' && stopped.ok && stopped.result, {
    results: [
      { id: ROW.id, outcome: 'stopped' },
      { id: '7-1', outcome: 'gone' },
    ],
  })
  assert.deepEqual(asked, [[ROW.id, '7-1']])

  for (const params of [
    { ids: [ROW.id] },
    { ids: [], commandId: 'c2' },
    { ids: ['4242'], commandId: 'c3' },
    { ids: ['-1-5'], commandId: 'c4' },
    { ids: 'all', commandId: 'c5' },
  ]) {
    assert.equal(codeOf(await request('processes.stop', params)), 'invalid_params', JSON.stringify(params))
  }
  assert.equal(asked.length, 1)
})

test('a paired app is refused the list and every stop, whatever it holds', async () => {
  const { stub, asked } = stubProcesses()
  const { started } = await ownerOver(stub)
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  // Every scope there is: ending a program here is an owner's, not a scope's.
  app.send(hello({ token: pairFakeClient(started.auth, 'app', [...STUDIO_SCOPES]) }))
  await app.next((frame) => frame.t === 'welcome')
  const calls = [
    ['processes.list', {}],
    ['processes.stop', { ids: [ROW.id], commandId: 'a1' }],
  ] as const
  for (const [index, [method, params]] of calls.entries()) {
    app.send({ t: 'req', id: `a${index}`, method, params })
    const refused = await app.next((frame) => frame.t === 'res' && frame.id === `a${index}`)
    assert.equal(codeOf(refused), 'owner_required', method)
  }
  assert.deepEqual(asked, [])
})
