// A live chat keeps what the extensions handed it, and at each turn's start
// it is compared with what they hand now: the generation says whether
// anything changed, and the withdrawn servers what a child must lose.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationMcpServer } from '../../shared/conversation-runtime'
import { handedExtensionServers, withdrawnExtensionServers } from './extension-mcp-servers'

const search: ConversationMcpServer = {
  id: 'acme_notes_search',
  name: 'Search',
  transport: 'stdio',
  command: '/Users/dev/ext/bin/search',
  env: { B: '2', A: '1' },
}
const tasks: ConversationMcpServer = {
  id: 'acme_tasks_hosted',
  name: 'Tasks',
  transport: 'http',
  url: 'https://mcp.example.com/tasks',
}

test('the same servers are the same generation, whatever their order or that of their variables', () => {
  const a = handedExtensionServers([search, tasks])
  const b = handedExtensionServers([tasks, { ...search, env: { A: '1', B: '2' } }])
  assert.equal(a.generation, b.generation)
  assert.deepEqual(withdrawnExtensionServers(a, b), [])
})

test('a server gone, or handed differently, is withdrawn; one only added is not', () => {
  const started = handedExtensionServers([search, tasks])
  assert.deepEqual(withdrawnExtensionServers(started, handedExtensionServers([tasks])), ['acme_notes_search'])
  assert.deepEqual(withdrawnExtensionServers(started, handedExtensionServers([{ ...search, args: ['--v2'] }, tasks])), [
    'acme_notes_search',
  ])
  assert.deepEqual(withdrawnExtensionServers(started, handedExtensionServers([])).sort(), [
    'acme_notes_search',
    'acme_tasks_hosted',
  ])
  const added = handedExtensionServers([search, tasks, { ...tasks, id: 'acme_tasks_more' }])
  assert.notEqual(added.generation, started.generation)
  assert.deepEqual(withdrawnExtensionServers(started, added), [])
  // A display name is not what a child runs.
  assert.equal(handedExtensionServers([{ ...search, name: 'Renamed' }, tasks]).generation, started.generation)
})
