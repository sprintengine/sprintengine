import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../../shared/workspace'
import { memoryEnvironmentChatsCache } from './environmentChatsCache'
import { ENVIRONMENT_CHATS_SEEDED_KEY, seedEnvironmentChatsOnce, seedRowsOf } from './environmentChatsSeed'

// The one-time seed: a machine away at the first start after its rows moved
// onto its own list still shows the chats this window kept records of.

const NOW = Date.UTC(2026, 10, 28, 12)
const SSH_ID = 'env-build-box'
const WSL_ID = 'env-ubuntu'
const PAIRED_ID = 'env-mac-mini'

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Chat ${id}`,
    mode: 'chat',
    folderPath: null,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 100,
    ...overrides,
  } as Workspace
}

const ROUTES = new Map([
  ['ssh:build-box', SSH_ID],
  ['wsl:Ubuntu', WSL_ID],
  ['tailnet:conn-mini', PAIRED_ID],
])
const idOfRoute = (route: string) => ROUTES.get(route) ?? null

const RECORDS = [
  workspace('local-1', { folderPath: '/Users/dev/app' }),
  workspace('ssh-1', {
    folderPath: '/home/dev/app',
    environment: { kind: 'ssh', id: 'build-box', label: 'build-box' },
    highlight: { starred: true, color: 'blue' },
    lastUserMessageAt: NOW - 1_000,
  }),
  workspace('wsl-1', { folderPath: '/home/dev/wsl', environment: { kind: 'wsl', id: 'Ubuntu', label: 'Ubuntu' } }),
  workspace('here-1', {
    remoteOrigin: { connectionId: 'conn-mini', workspaceId: 'mini-chat', workspaceRoot: '/Users/dev/site' },
  } as Partial<Workspace>),
  // The same paired chat, opened in a second window.
  workspace('here-2', {
    remoteOrigin: { connectionId: 'conn-mini', workspaceId: 'mini-chat', workspaceRoot: '/Users/dev/site' },
  } as Partial<Workspace>),
  // A machine whose id the list does not know yet.
  workspace('ssh-unknown', { environment: { kind: 'ssh', id: 'old-box', label: 'old-box' } }),
]

test('each copy and paired record becomes its machine’s row, under that machine’s id for the chat', () => {
  const seeded = seedRowsOf(RECORDS, idOfRoute, NOW)
  assert.deepEqual(
    [...seeded.keys()].sort(),
    [PAIRED_ID, SSH_ID, WSL_ID].sort(),
    'this machine’s and unknown routes are not seeded',
  )
  const ssh = seeded.get(SSH_ID)!
  assert.equal(ssh.route, 'ssh:build-box')
  assert.deepEqual(
    ssh.workspaces.map((row) => [row.id, row.folderPath]),
    [['ssh-1', '/home/dev/app']],
  )
  assert.deepEqual(ssh.workspaces[0]!.row?.highlight, { starred: true, color: 'blue' })
  assert.equal(ssh.workspaces[0]!.row?.recencyAt, NOW - 1_000)
  const paired = seeded.get(PAIRED_ID)!
  assert.deepEqual(
    paired.workspaces.map((row) => [row.id, row.folderPath]),
    [['mini-chat', '/Users/dev/site']],
    'one row for the chat, by its id on its machine',
  )
})

test('it runs once, writes only where no list is kept, and waits for the window’s records', async () => {
  const lists = new Map<string, unknown>()
  const cache = memoryEnvironmentChatsCache(lists)
  await cache.save(WSL_ID, { browse: null, conversations: [] })
  const storage = new Map<string, string>()
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  }

  // Records that never load leave the seed for later.
  await seedEnvironmentChatsOnce({
    ready: new Promise<void>(() => undefined),
    workspaces: () => RECORDS,
    idOfRoute,
    cache,
    storage: store,
    waitMs: 5,
  })
  assert.equal(storage.has(ENVIRONMENT_CHATS_SEEDED_KEY), false)
  assert.equal(await cache.load(SSH_ID), null)

  await seedEnvironmentChatsOnce({
    ready: Promise.resolve(),
    workspaces: () => RECORDS,
    idOfRoute,
    cache,
    storage: store,
  })
  assert.equal(storage.get(ENVIRONMENT_CHATS_SEEDED_KEY), '1')
  assert.deepEqual(
    (await cache.load(SSH_ID))?.browse?.workspaces.map((row) => row.id),
    ['ssh-1'],
  )
  assert.deepEqual(
    (await cache.load(PAIRED_ID))?.browse?.workspaces.map((row) => row.id),
    ['mini-chat'],
  )
  assert.equal((await cache.load(WSL_ID))?.browse, null, 'a list already kept is left alone')

  // Once: a later start writes nothing, even where the list has gone.
  await cache.keepOnly(new Set())
  await seedEnvironmentChatsOnce({
    ready: Promise.resolve(),
    workspaces: () => RECORDS,
    idOfRoute,
    cache,
    storage: store,
  })
  assert.equal(await cache.load(SSH_ID), null)
})
