import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { createEnvironmentClients } from './environment-client'

// Main's own client of an SSH machine's Studio, as the desktop's callers reach
// a chat there: its owner connection, its paths spelled for this computer, and
// a machine it cannot reach said so in words.

function fakeOwner() {
  const asked: Array<{ method: string; params: unknown }> = []
  const client = {
    async request(method: string, params: unknown) {
      asked.push({ method, params })
      return { workspaceRoot: '/home/dev/repo', planFilePath: '/home/dev/repo/plan.md', text: '/home/dev/words' }
    },
    conversations: {},
  } as unknown as StudioClient
  return { client, asked }
}

test('a route that is no SSH machine, and a machine it cannot reach, are refused in words', async () => {
  const listeners: Array<(connection: { key: string }) => void> = []
  const clients = createEnvironmentClients({
    ssh: {
      ownerClient: async (id) => ({ ok: false, code: 'unavailable', message: `${id} is not connected.` }),
      onConnected: (listener) => void listeners.push(listener),
    },
  })
  const tailnet = await clients.clientFor('tailnet:abc')
  assert.ok(!tailnet.ok && tailnet.code === 'unsupported_route' && tailnet.message.length > 0)
  const away = await clients.clientFor('ssh:build-box')
  assert.ok(!away.ok && away.message === 'build-box is not connected.')
  const none = await createEnvironmentClients({}).clientFor('ssh:build-box')
  assert.ok(!none.ok && none.code === 'unsupported_route')
})

test('its client hands the machine plain paths and spells what comes back for this computer', async () => {
  const owner = fakeOwner()
  const clients = createEnvironmentClients({
    ssh: {
      ownerClient: async () => ({ ok: true, client: owner.client, label: 'build-box' }),
      onConnected: () => undefined,
    },
  })
  const reached = await clients.clientFor('ssh:build-box')
  assert.ok(reached.ok)
  assert.equal(reached.name, 'build-box')
  const answer = (await reached.client.request('session.list', {
    workspaceId: 'w1',
    workspaceRoot: 'ssh://build-box/home/dev/repo',
  } as never)) as unknown as Record<string, string>
  assert.deepEqual(owner.asked[0]?.params, { workspaceId: 'w1', workspaceRoot: '/home/dev/repo' })
  assert.equal(answer.workspaceRoot, 'ssh://build-box/home/dev/repo')
  assert.equal(answer.planFilePath, 'ssh://build-box/home/dev/repo/plan.md')
  assert.equal(answer.text, '/home/dev/words', 'words are left as they were written')
})

test('a machine that connects is told by its route', () => {
  const listeners: Array<(connection: { key: string }) => void> = []
  const clients = createEnvironmentClients({
    ssh: {
      ownerClient: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
      onConnected: (listener) => void listeners.push(listener),
    },
  })
  const heard: string[] = []
  const stop = clients.onConnected((route) => heard.push(route))
  for (const listener of listeners) listener({ key: 'ssh:build-box' })
  stop()
  for (const listener of listeners) listener({ key: 'ssh:other' })
  assert.deepEqual(heard, ['ssh:build-box'])
})
