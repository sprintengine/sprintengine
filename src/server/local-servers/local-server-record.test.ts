import { savedRecordRows, seedRecordRows, testDatabaseAt } from '../../../tests/studio-database'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  createLocalServerRecord,
  readLinkedServersFile,
  MAX_SERVERS,
  MAX_SERVERS_PER_CONVERSATION,
  readLocalServerUrl,
  type LocalServerRecordOptions,
} from './local-server-record'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'local-server-record-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function recordIn(dir: string, extra: Partial<LocalServerRecordOptions> = {}) {
  let clock = 1_000
  let seq = 0
  const logs: string[] = []
  const record = createLocalServerRecord({
    database: testDatabaseAt(dir),
    now: () => ++clock,
    newId: () => `id-${++seq}`,
    log: (message) => logs.push(message),
    ...extra,
  })
  // Its last write lands before the folder goes.
  cleanups.push(() => record.flush())
  return { record, logs }
}

const A = { workspaceId: 'ws-1', agentId: 'agent-a' }
const B = { workspaceId: 'ws-1', agentId: 'agent-b' }

test('a URL is read as http or https with a host, and the unspecified address becomes localhost', () => {
  assert.deepEqual(readLocalServerUrl(' http://0.0.0.0:5173/app '), {
    url: 'http://localhost:5173/app',
    host: 'localhost',
    port: 5173,
  })
  assert.deepEqual(readLocalServerUrl('http://[::]:3000'), {
    url: 'http://localhost:3000/',
    host: 'localhost',
    port: 3000,
  })
  assert.equal(readLocalServerUrl('http://127.0.0.1:8080/')?.host, 'localhost')
  assert.equal(readLocalServerUrl('http://[::1]:8080/')?.host, 'localhost')
  assert.equal(readLocalServerUrl('https://dev-macbook-air.tail1234.ts.net/')?.port, 443)
  assert.equal(readLocalServerUrl('http://192.168.1.20/')?.port, 80)
  assert.equal(readLocalServerUrl('ftp://localhost:21/'), null)
  assert.equal(readLocalServerUrl('localhost:5173'), null)
  assert.equal(readLocalServerUrl(`http://localhost/${'x'.repeat(3000)}`), null)
})

test('the same conversation linking an address again updates it in place and moves it to the top', async () => {
  const { record } = recordIn(await dataDir())
  await record.whenLoaded()
  const first = record.link(A, {
    url: 'http://localhost:5173/',
    title: 'Web',
    command: 'npm run dev',
    cwd: '/Users/dev/app',
  })
  record.link(A, { url: 'http://localhost:6006/', title: 'Storybook' })
  const again = record.link(A, { url: 'http://127.0.0.1:5173/admin', title: 'Admin' })
  assert.equal(again.created, false)
  assert.equal(again.server.id, first.server.id)
  assert.equal(again.server.url, 'http://127.0.0.1:5173/admin')
  assert.equal(again.server.title, 'Admin')
  // What the re-link left out is kept: renaming it does not lose how to run it.
  assert.equal(again.server.command, 'npm run dev')
  assert.equal(again.server.cwd, '/Users/dev/app')
  assert.deepEqual(
    record.forConversation(A).map((entry) => entry.port),
    [5173, 6006],
  )
})

test('another conversation linking the same address takes it over, keeping its id', async () => {
  const { record } = recordIn(await dataDir())
  await record.whenLoaded()
  const first = record.link(A, { url: 'http://localhost:5173/', command: 'npm run dev' })
  const moved = record.link(B, { url: 'http://[::1]:5173/', title: 'Mine now' })
  assert.equal(moved.created, false)
  assert.deepEqual(moved.movedFrom, A)
  assert.equal(moved.server.id, first.server.id)
  assert.equal(moved.server.agentId, 'agent-b')
  // The other agent's command is not this one's.
  assert.equal(moved.server.command, undefined)
  assert.deepEqual(record.forConversation(A), [])
  assert.equal(record.forConversation(B).length, 1)
  assert.equal(record.forWorkspace('ws-1').length, 1)
})

test('a conversation keeps its newest links up to the cap, and the record its newest in all', async () => {
  const { record } = recordIn(await dataDir())
  await record.whenLoaded()
  let dropped = 0
  for (let port = 3000; port < 3000 + MAX_SERVERS_PER_CONVERSATION + 2; port++) {
    dropped += record.link(A, { url: `http://localhost:${port}/` }).dropped.length
  }
  assert.equal(dropped, 2)
  const own = record.forConversation(A)
  assert.equal(own.length, MAX_SERVERS_PER_CONVERSATION)
  assert.equal(own[0]?.port, 3000 + MAX_SERVERS_PER_CONVERSATION + 1)
  assert.equal(own.at(-1)?.port, 3002)

  for (let index = 0; index < MAX_SERVERS; index++) {
    record.link({ workspaceId: 'ws-2', agentId: `agent-${index}` }, { url: `http://localhost:${10_000 + index}/` })
  }
  assert.equal(record.all().length, MAX_SERVERS)
  // The oldest went first: conversation A's links were linked before all of these.
  assert.deepEqual(record.forConversation(A), [])
})

test('the record is kept in the database, a row per link, and read back after a restart', async () => {
  const dir = await dataDir()
  const { record } = recordIn(dir)
  await record.whenLoaded()
  record.link(A, { url: 'http://localhost:5173/', title: 'Web', command: 'npm run dev', cwd: '/Users/dev/app' })
  record.link(B, { url: 'http://192.168.1.20:3000/' })
  const removed = record.link(B, { url: 'http://localhost:4000/' })
  assert.notEqual(record.remove(removed.server.id), null)
  assert.equal(record.remove('nope'), null)
  await record.flush()
  assert.equal((await savedRecordRows(dir, 'linked_servers')).length, 2)

  const { record: reread } = recordIn(dir)
  await reread.whenLoaded()
  assert.deepEqual(reread.forConversation(A), record.forConversation(A))
  assert.deepEqual(reread.forConversation(B), record.forConversation(B))
})

test('a missing record is an empty one, and entries it cannot read are skipped', async () => {
  const empty = recordIn(await dataDir())
  await empty.record.whenLoaded()
  assert.deepEqual(empty.record.all(), [])
  assert.deepEqual(empty.logs, [])

  const dir = await dataDir()
  const good = {
    id: 'k1',
    workspaceId: 'ws-1',
    agentId: 'agent-a',
    url: 'http://localhost:5173/',
    title: '',
    linkedAt: 5,
  }
  seedRecordRows(dir, 'linked_servers', [
    { id: 'k1', body: good },
    { id: 'k2', body: { ...good, id: 'k2', url: 'ftp://x/' } },
    { id: 'k3', body: { ...good, id: 'k3', cwd: 'relative' } },
  ])
  const { record } = recordIn(dir)
  await record.whenLoaded()
  assert.deepEqual(
    record.all().map((entry) => entry.id),
    ['k1'],
  )
  // The file builds before the database kept, as the import reads it.
  assert.deepEqual(
    readLinkedServersFile(JSON.stringify({ version: 1, servers: [good, { ...good, id: 'k2', url: 'ftp://x/' }] }))?.map(
      (entry) => entry.id,
    ),
    ['k1'],
  )
  assert.equal(readLinkedServersFile('{"version": 1, "servers": ['), null)
})

test('a link a run is following is never pushed out by the caps', async () => {
  const { record } = recordIn(await dataDir(), { keep: (id) => id === 'id-1' })
  await record.whenLoaded()
  for (let port = 3000; port < 3000 + MAX_SERVERS_PER_CONVERSATION + 2; port++) {
    record.link(A, { url: `http://localhost:${port}/` })
  }
  const own = record.forConversation(A)
  assert.equal(own.length, MAX_SERVERS_PER_CONVERSATION)
  assert.ok(record.get('id-1'), "the run's link stays")
  // The next oldest went in its place.
  assert.equal(record.get('id-2'), undefined)
  assert.equal(record.get('id-3'), undefined)
})

test('only the default loopback is one host: another 127 address is its own', () => {
  assert.equal(readLocalServerUrl('http://[::1]:5173/')?.host, 'localhost')
  assert.equal(readLocalServerUrl('http://[::ffff:127.0.0.1]:5173/')?.host, 'localhost')
  assert.equal(readLocalServerUrl('http://127.0.0.2:5173/')?.host, '127.0.0.2')
})
