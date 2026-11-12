import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioEnvironmentReadiness } from '../../../packages/studio-protocol/src/public'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `environment.readiness` over the owner socket: advertised where the core
// answers it, refused `unavailable` where it does not. What it says is
// environment-readiness.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const READY: StudioEnvironmentReadiness = {
  machine: 'build-box',
  clis: [{ id: 'codex', name: 'Codex', installed: true, signedIn: false }],
  gh: { installed: true, signedIn: true },
  mcpServers: [],
  extensions: [],
  waiting: [{ kind: 'schedule', id: 'sa-1', title: 'Nightly triage', reason: 'Codex is not signed in on build-box' }],
}

async function ownerOver(readiness?: () => Promise<StudioEnvironmentReadiness>) {
  const started = await startTestServer(readiness ? { readiness } : {})
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  const request = async (method: string) => {
    owner.send({ t: 'req', id: 'r1', method, params: {} })
    return owner.next((frame) => frame.t === 'res' && frame.id === 'r1')
  }
  return { welcome, request }
}

test('a Studio says what its machine lacks for its background work, and one that cannot does not offer it', async () => {
  const answering = await ownerOver(async () => READY)
  assert.equal(
    answering.welcome.t === 'welcome' && answering.welcome.capabilities.includes('environment-readiness'),
    true,
  )
  const read = await answering.request('environment.readiness')
  assert.deepEqual(read.t === 'res' && read.ok ? read.result : null, READY)

  const silent = await ownerOver()
  assert.equal(silent.welcome.t === 'welcome' && silent.welcome.capabilities.includes('environment-readiness'), false)
  const refused = await silent.request('environment.readiness')
  assert.equal(refused.t === 'res' && !refused.ok ? refused.error?.code : null, 'unavailable')
})

test('a paired app that may not read chats is told what the machine has, not which schedules wait', async () => {
  const started = await startTestServer({ readiness: async () => READY })
  cleanups.push(() => started.dispose())
  const ask = async (scopes: Parameters<typeof pairFakeClient>[2], name: string) => {
    const client = await connectLineClient(started.path)
    cleanups.push(() => client.close())
    client.send(hello({ token: pairFakeClient(started.auth, name, scopes) }))
    await client.next((frame) => frame.t === 'welcome')
    client.send({ t: 'req', id: 'r1', method: 'environment.readiness', params: {} })
    const answer = await client.next((frame) => frame.t === 'res' && frame.id === 'r1')
    return answer.t === 'res' && answer.ok ? (answer.result as StudioEnvironmentReadiness) : null
  }
  const providersOnly = await ask(['providers:read'], 'settings-app')
  assert.deepEqual(providersOnly?.clis, READY.clis)
  assert.deepEqual(providersOnly?.waiting, [])
  const chats = await ask(['providers:read', 'conversation:read'], 'chat-app')
  assert.deepEqual(chats?.waiting, READY.waiting)
})
