import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { HostsListResult } from '../../../packages/studio-protocol/src/public'
import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/scopes'
import type { StudioHosts } from './studio-rpc-router'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `hosts.*` over the owner socket: the capability, the list and its stream, as
// a window reads them for New chat's machine list and Settings ▸ Machines. The
// registry behind them is a stub; what it lists is host-registry.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const LISTING: HostsListResult = {
  hosts: [
    { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
    {
      id: 'wsl:Ubuntu',
      kind: 'wsl',
      label: 'WSL: Ubuntu',
      pathStyle: 'wsl',
      state: 'ready',
      enabled: true,
      server: { state: 'ready', transport: 'loopback' },
    },
  ],
  wsl: { available: true },
}

function stubHosts() {
  const asked: Array<{ refresh?: boolean; all?: boolean }> = []
  const listeners = new Set<() => void>()
  let listening: () => void = () => undefined
  const subscribed = new Promise<void>((resolve) => {
    listening = resolve
  })
  const stub: StudioHosts = {
    list: async (options) => {
      asked.push(options)
      return LISTING
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listening()
      return () => listeners.delete(listener)
    },
  }
  return { stub, asked, subscribed, changed: () => listeners.forEach((listener) => listener()) }
}

async function ownerOver(hosts?: StudioHosts) {
  const started = await startTestServer(hosts ? { hosts } : {})
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

test("a desktop's Studio advertises this computer's machines, and one without them does not", async () => {
  const withThem = await ownerOver(stubHosts().stub)
  assert.equal(withThem.welcome.t === 'welcome' && withThem.welcome.capabilities.includes('execution-hosts'), true)
  const without = await ownerOver()
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('execution-hosts'), false)
  assert.equal(codeOf(await without.request('hosts.list', {})), 'unavailable')
})

test('an owner lists the machines, asking WSL again only with refresh, and malformed params are refused', async () => {
  const { stub, asked } = stubHosts()
  const { request } = await ownerOver(stub)
  const listed = await request('hosts.list', { all: true, refresh: true })
  assert.deepEqual(listed.t === 'res' && listed.ok && listed.result, LISTING)
  await request('hosts.list', {})
  assert.deepEqual(asked, [{ all: true, refresh: true }, {}])
  assert.equal(codeOf(await request('hosts.list', { refresh: 'yes' })), 'invalid_params')
  assert.equal(codeOf(await request('hosts.list', { all: 1 })), 'invalid_params')
})

test('a paired app is refused the list and its stream, whatever it holds', async () => {
  const { stub, asked } = stubHosts()
  const { started } = await ownerOver(stub)
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  // Every scope there is: a refresh starts WSL on this computer, which is an owner's.
  app.send(hello({ token: pairFakeClient(started.auth, 'app', [...STUDIO_SCOPES]) }))
  await app.next((frame) => frame.t === 'welcome')
  app.send({ t: 'req', id: 'a0', method: 'hosts.list', params: { refresh: true } })
  assert.equal(codeOf(await app.next((frame) => frame.t === 'res' && frame.id === 'a0')), 'owner_required')
  app.send({ t: 'sub', id: 's0', topic: 'hosts.changed', params: {} })
  const failed = await app.next((frame) => frame.t === 'subFailed' && frame.sub === 's0')
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
  assert.deepEqual(asked, [])
})

test('the stream says only that the list may read differently', async () => {
  const { stub, changed, subscribed } = stubHosts()
  const { owner } = await ownerOver(stub)
  owner.send({ t: 'sub', id: 's1', topic: 'hosts.changed' })
  await subscribed
  changed()
  const pushed = await owner.next((frame) => frame.t === 'push' && frame.sub === 's1')
  assert.deepEqual(pushed.t === 'push' && pushed.payload, {})
})
