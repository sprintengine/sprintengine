import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioAgentProcess, StudioProcessesMethodMap } from '../../../packages/studio-protocol/src/public'
import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/scopes'
import type { StudioProcesses } from '../processes/agent-process-domain'
import { addressWithoutSecrets, tabsForReader, type StudioBrowserTabs } from '../processes/browser-tabs'
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

// ── Browser tabs ────────────────────────────────────────────────────────────

const TAB = {
  tabId: 'tab-1',
  workspaceId: 'ws-1',
  title: 'Game',
  url: 'http://dev:hunter2@localhost:5173/game?token=abc123#state',
  openedAt: 1,
  lastUsedAt: 2,
  audible: true,
  agentIds: ['agent-1'],
  inView: false,
  closesAt: 3,
}

function stubTabs() {
  const closed: string[] = []
  const stub: StudioBrowserTabs = {
    list: async () => [TAB],
    close: async (tabId) => {
      closed.push(tabId)
      return tabId === TAB.tabId
    },
  }
  return { stub, closed }
}

test('a Studio given the browser tabs advertises them; an owner lists and closes one', async () => {
  const { stub, closed } = stubTabs()
  const started = await startTestServer({ browserTabs: stub })
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('browser-tabs'), true)
  owner.send({ t: 'req', id: 'l', method: 'browserTabs.list', params: {} })
  const listed = await owner.next((frame) => frame.t === 'res' && frame.id === 'l')
  assert.deepEqual(listed.t === 'res' && listed.ok && listed.result, { tabs: [TAB] })
  owner.send({ t: 'req', id: 'c', method: 'browserTabs.close', params: { tabId: 'tab-1', commandId: 'c1' } })
  const answer = await owner.next((frame) => frame.t === 'res' && frame.id === 'c')
  assert.deepEqual(answer.t === 'res' && answer.ok && answer.result, { closed: true })
  owner.send({ t: 'req', id: 'bad', method: 'browserTabs.close', params: { tabId: '', commandId: 'c2' } })
  assert.equal(codeOf(await owner.next((frame) => frame.t === 'res' && frame.id === 'bad')), 'invalid_params')
  assert.deepEqual(closed, ['tab-1'])
  const without = await ownerOver()
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('browser-tabs'), false)
})

test('a paired app that may operate a workspace sees the tabs and closes one; one that may not is refused', async () => {
  const { stub, closed } = stubTabs()
  const started = await startTestServer({ browserTabs: stub })
  cleanups.push(() => started.dispose())
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  app.send(hello({ token: pairFakeClient(started.auth, 'app', ['workspaces:read', 'workspaces:operate']) }))
  await app.next((frame) => frame.t === 'welcome')
  app.send({ t: 'req', id: 'l', method: 'browserTabs.list', params: {} })
  const listed = await app.next((frame) => frame.t === 'res' && frame.id === 'l')
  // Another connection reads each address without its userinfo, query or fragment.
  const seen = listed.t === 'res' && listed.ok ? (listed.result as { tabs: Array<{ url: string }> }).tabs : []
  assert.deepEqual(
    seen.map((entry) => entry.url),
    ['http://localhost:5173/game'],
  )
  app.send({ t: 'req', id: 'c', method: 'browserTabs.close', params: { tabId: 'tab-1', commandId: 'a1' } })
  const answer = await app.next((frame) => frame.t === 'res' && frame.id === 'c')
  assert.deepEqual(answer.t === 'res' && answer.ok && answer.result, { closed: true })

  const reader = await connectLineClient(started.path)
  cleanups.push(() => reader.close())
  reader.send(hello({ token: pairFakeClient(started.auth, 'reader', ['workspaces:read']) }))
  await reader.next((frame) => frame.t === 'welcome')
  reader.send({ t: 'req', id: 'c', method: 'browserTabs.close', params: { tabId: 'tab-1', commandId: 'r1' } })
  assert.equal(codeOf(await reader.next((frame) => frame.t === 'res' && frame.id === 'c')), 'scope_required')
  assert.deepEqual(closed, ['tab-1'])
})

test('a tab as another connection reads it: its title redacted, its address without what rides after the path', () => {
  assert.equal(addressWithoutSecrets('https://me:pw@example.com/a/b?q=1#x'), 'https://example.com/a/b')
  assert.equal(addressWithoutSecrets('about:blank'), 'about:')
  assert.equal(addressWithoutSecrets('not a url'), '')
  const redact = <T>(value: T): T => (typeof value === 'string' ? (value.replace('secret', '[redacted]') as T) : value)
  const [mine] = tabsForReader([{ ...TAB, title: 'secret page' }], { owner: true, redact })
  assert.deepEqual([mine!.title, mine!.url], ['[redacted] page', TAB.url])
  const [theirs] = tabsForReader([{ ...TAB, title: 'secret page' }], { owner: false, redact })
  assert.deepEqual([theirs!.title, theirs!.url], ['[redacted] page', 'http://localhost:5173/game'])
})
