import assert from 'node:assert/strict'

import { afterEach, beforeEach, test, vi } from 'vitest'

import { StudioError } from '../../../../packages/client-runtime/src/public'
import type { WindowActivity } from '../utils/windowActivity'
import { createEnvironmentChatSource, followEnvironmentChats, knowEnvironments } from './environmentChats'
import {
  cachedRowsOf,
  ENVIRONMENT_CHATS_CACHE_VERSION,
  memoryEnvironmentChatsCache,
  type EnvironmentChatsCache,
} from './environmentChatsCache'
import { fakePairedStudios } from './environmentStudio.double'
import { holdEnvironmentStudio, pairedTarget } from './environmentStudio'

// An environment's last-known rows: kept by its id when a read answers, drawn
// by a window that starts while it is away, replaced by its live rows once it
// answers, dropped when it is forgotten, and never read across a change of
// what is stored.

const ID = 'env_0123456789abcdefghijklmn'
const OTHER = 'env_abcdefghijklmn0123456789'

const chat = {
  workspaceId: 'rw1',
  agentId: 'ada',
  title: 'Ada',
  phase: 'idle',
  updatedAt: 2_000,
  createdAt: 1_000,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 4,
} as never

const still: WindowActivity = {
  get: () => ({ visible: true, focused: true }),
  subscribe: () => () => undefined,
  dispose: () => undefined,
}

const target = pairedTarget({ id: 'c1', machineName: 'mac-mini' })

function machine(environmentId: string, list: () => unknown) {
  const api = {}
  const studio = fakePairedStudios(api, {
    'workspaces.list': () => ({ workspaces: [] }),
    'conversation.list': list,
    'session.list': () => ({ ok: true, sessions: [] }),
  })
  const sourceOf = (cache: EnvironmentChatsCache) =>
    createEnvironmentChatSource(target, {
      hold: (given) => holdEnvironmentStudio(given, { api: api as never }),
      activity: still,
      cache,
    })
  return { studio, sourceOf, environmentId }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  followEnvironmentChats([])
  vi.useRealTimers()
})

test('a list of another version, or of another environment, is dropped rather than read', async () => {
  const cache = memoryEnvironmentChatsCache()
  await cache.save(ID, { browse: null, conversations: [chat], listedAt: 5 })
  assert.deepEqual((await cache.load(ID))?.conversations, [chat])
  assert.equal(await cache.load(OTHER), null)

  // What an older or newer build stored under the same id.
  const lists = new Map<string, unknown>([
    [ID, { version: ENVIRONMENT_CHATS_CACHE_VERSION + 1, environmentId: ID, savedAt: 1, rows: { browse: null } }],
    [OTHER, { version: ENVIRONMENT_CHATS_CACHE_VERSION, environmentId: ID, savedAt: 1, rows: { browse: null } }],
  ])
  const older = memoryEnvironmentChatsCache(lists)
  assert.equal(await older.load(ID), null, 'another version is not read')
  assert.equal(await older.load(OTHER), null, 'nor a list saved under another environment')
  assert.equal(lists.size, 0, 'and both are dropped')

  await cache.keepOnly(new Set([OTHER]))
  assert.equal(await cache.load(ID), null, 'an environment no longer listed loses its list')
})

test('only what was read is kept: nothing before a read answers, and never how a read went', () => {
  assert.equal(cachedRowsOf({ browse: null, loading: true, error: null, at: null }), null)
  const kept = cachedRowsOf({
    browse: null,
    loading: false,
    error: 'Not answering.',
    at: 9,
    conversations: [chat],
    listedAt: 7,
    listFailure: { kind: 'unavailable', message: 'Not answering.' },
  })
  assert.deepEqual(kept, { browse: null, conversations: [chat], listedAt: 7 })
})

test('a window that starts while the environment is away draws its last-known rows, and its live rows replace them', async () => {
  const cache = memoryEnvironmentChatsCache()
  let listed = [chat]
  const box = machine(ID, () => ({ conversations: listed }))

  // A first start: the environment answers, and its rows are kept.
  const first = box.sourceOf(cache)
  first.subscribe(() => undefined)
  first.loadCached(`env-c1`)
  await vi.advanceTimersByTimeAsync(2_000)
  first.close()
  const kept = await cache.load('env-c1')
  assert.equal(kept?.conversations?.length, 1, 'kept by the id its welcome said')
  assert.ok(kept?.browse, 'with what it holds')

  // The next start: the environment is away.
  const asleep = machine(ID, () => ({ conversations: listed }))
  asleep.studio.refuse = () => new StudioError('unavailable', 'Not answering.')
  const away = asleep.sourceOf(cache)
  away.subscribe(() => undefined)
  away.loadCached('env-c1')
  await vi.advanceTimersByTimeAsync(0)
  assert.deepEqual(
    away.snapshot().rows.conversations?.map((conversation) => conversation.workspaceId),
    ['rw1'],
    'its last-known rows are drawn',
  )
  assert.equal(away.snapshot().rows.listedAt, kept?.listedAt, 'as old as they are')
  away.close()

  // And once it answers, what it lists now is what is drawn.
  listed = []
  const back = machine(ID, () => ({ conversations: listed })).sourceOf(cache)
  back.subscribe(() => undefined)
  back.loadCached('env-c1')
  await vi.advanceTimersByTimeAsync(2_000)
  assert.deepEqual(back.snapshot().rows.conversations, [], 'the live list replaces the kept one')
  back.close()
  assert.deepEqual((await cache.load('env-c1'))?.conversations, [], 'and is kept in its place')
})

test('the environment list says which environment each followed route is, and forgets the ones it drops', async () => {
  const cache = memoryEnvironmentChatsCache()
  await cache.save(ID, { browse: null, conversations: [chat], listedAt: 5 })
  await cache.save(OTHER, { browse: null, conversations: [chat], listedAt: 5 })
  const box = machine(ID, () => new Promise(() => undefined))
  box.studio.refuse = () => new StudioError('unavailable', 'Not answering.')
  followEnvironmentChats([target], () => box.sourceOf(cache))
  knowEnvironments([{ environmentId: ID, routes: [target.route] }], cache)
  await vi.advanceTimersByTimeAsync(0)
  const [source] = (await import('./environmentChats')).followedEnvironmentChats()
  assert.equal(source?.snapshot().rows.conversations?.length, 1, 'the followed route draws its environment’s rows')
  assert.equal(await cache.load(OTHER), null, 'an environment the list no longer holds is forgotten')

  knowEnvironments([], cache)
  assert.ok(await cache.load(ID), 'a list not read yet forgets nothing')
})
