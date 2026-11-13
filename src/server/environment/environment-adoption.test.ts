import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { StudioAdoptedRecord } from '../../../packages/studio-protocol/src/public'
import {
  adoptedRecordDigest,
  canonicalRecordJson,
  createEnvironmentAdoption,
  type EnvironmentAdoptionStores,
} from './environment-adoption'

// A machine's Studio keeping what a desktop kept for its chats: each record in
// its own store, once, a repeat held again without a second copy, a record
// that differs from what is here left as this Studio has it, and the answer
// given only once every store and the ledger are written.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeStores() {
  const calls: string[] = []
  const workspaces = new Set<string>()
  const schedules = new Set<string>()
  const sources = new Set<string>()
  let flushed = 0
  const stores: EnvironmentAdoptionStores = {
    async flush() {
      flushed += 1
      calls.push('flush')
    },
    workspaces: {
      has: (id) => workspaces.has(id),
      adopt(record) {
        calls.push(`workspace ${String(record.id)}`)
        workspaces.add(String(record.id))
        return { ok: true }
      },
    },
    schedules: {
      has: (id) => schedules.has(id),
      async adopt(record) {
        const id = String((record as { id: unknown }).id)
        calls.push(`schedule ${id}`)
        if ((record as { prompt?: unknown }).prompt === undefined)
          return { ok: false, reason: 'invalid', message: 'A scheduled agent has a prompt.' }
        schedules.add(id)
        return { ok: true }
      },
    },
    messages: {
      scheduleFrom(chat, text, sendAt, source) {
        calls.push(`schedule-message ${chat.agentId} ${text} ${sendAt}`)
        sources.add(source)
        return { ok: true }
      },
      hold(chat, text, source) {
        calls.push(`hold ${chat.agentId} ${text}`)
        sources.add(source)
        return { ok: true }
      },
    },
    resumes: {
      schedule: (chat) => void calls.push(`resume ${chat.agentId}`),
    },
    pullRequests: {
      async noteOpened(chat, input) {
        calls.push(`opened ${chat.agentId} ${input.url}`)
        return input.url.endsWith('/9')
          ? { ok: false, code: 'opened_by_another_conversation', message: 'Another chat here opened it.' }
          : { ok: true }
      },
      async watch(chat, input) {
        calls.push(`watch ${chat.agentId} ${input.url}`)
        return { ok: true }
      },
    },
  }
  return { stores, calls, workspaces, flushed: () => flushed }
}

function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), 'environment-adoption-'))
  dirs.push(dataDir)
  const fake = fakeStores()
  const adoption = createEnvironmentAdoption({ dataDir, stores: fake.stores, now: () => 1_000 })
  return { ...fake, adoption, dataDir }
}

function record(kind: StudioAdoptedRecord['kind'], id: string, body: Record<string, unknown>): StudioAdoptedRecord {
  return { kind, id, digest: adoptedRecordDigest(body), body }
}

const WORKSPACE = { id: 'ws-1', name: 'repo', folderPath: '/home/dev/repo', agents: {} }
const SCHEDULE = { id: 'sa-1', prompt: 'Triage the inbox', workspaceId: 'ws-1' }

test('the digest is of the body as canonical JSON, whatever order its keys came in', () => {
  assert.equal(canonicalRecordJson({ b: 1, a: { d: [1, 'x'], c: null } }), '{"a":{"c":null,"d":[1,"x"]},"b":1}')
  assert.equal(adoptedRecordDigest({ b: 1, a: 2 }), adoptedRecordDigest({ a: 2, b: 1 }))
  assert.notEqual(adoptedRecordDigest({ a: 1 }), adoptedRecordDigest({ a: 2 }))
})

test('each kind goes into its own store, a workspace first, and the answer waits for the stores and the ledger', async () => {
  const { adoption, calls, dataDir } = rig()
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      record('pull-request', 'pr-1', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        url: 'https://github.com/o/r/pull/1',
        watched: true,
      }),
      record('schedule', 'sa-1', SCHEDULE),
      record('scheduled-message', 'sm-1', { workspaceId: 'ws-1', agentId: 'a1', text: 'later', sendAt: 5_000 }),
      record('scheduled-message', 'sm-2', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'after this turn',
        queued: true,
      }),
      record('usage-limit-resume', 'ul-1', { workspaceId: 'ws-1', agentId: 'a1' }),
      record('workspace', 'ws-1', WORKSPACE),
    ],
  })
  assert.deepEqual(answer.conflicts, [])
  assert.deepEqual(
    answer.held.map((entry) => `${entry.kind}:${entry.id}`),
    [
      'workspace:ws-1',
      'schedule:sa-1',
      'scheduled-message:sm-1',
      'scheduled-message:sm-2',
      'usage-limit-resume:ul-1',
      'pull-request:pr-1',
    ],
  )
  assert.deepEqual(calls, [
    'workspace ws-1',
    'schedule sa-1',
    'schedule-message a1 later 5000',
    'hold a1 after this turn',
    'resume a1',
    'opened a1 https://github.com/o/r/pull/1',
    'watch a1 https://github.com/o/r/pull/1',
    'flush',
  ])
  const ledger = join(dataDir, 'environment-adoptions.json')
  assert.equal(statSync(ledger).mode & 0o777, 0o600)
  assert.ok(JSON.parse(readFileSync(ledger, 'utf8')).records['workspace:ws-1'])
})

test('a hand-over repeated is held again with nothing written twice; one that differs keeps this Studio’s copy', async () => {
  const { adoption, calls } = rig()
  const first = [record('workspace', 'ws-1', WORKSPACE), record('schedule', 'sa-1', SCHEDULE)]
  await adoption.adopt({ migrationId: 'm-1', records: first })
  calls.length = 0
  const again = await adoption.adopt({ migrationId: 'm-1', records: first })
  assert.deepEqual(again.held.length, 2)
  assert.deepEqual(again.conflicts, [])
  assert.deepEqual(calls, ['flush'], 'nothing kept a second time')

  const changed = await adoption.adopt({
    migrationId: 'm-2',
    records: [record('workspace', 'ws-1', { ...WORKSPACE, name: 'renamed' })],
  })
  assert.deepEqual(changed.held, [])
  assert.match(changed.conflicts[0]?.reason ?? '', /keeps that one/u)
  assert.deepEqual(calls, ['flush', 'flush'])
})

test('a hand-over that stopped after its stores but before its ledger is held when it comes again', async () => {
  const { adoption, calls, stores, dataDir } = rig()
  const records = [record('workspace', 'ws-1', WORKSPACE), record('schedule', 'sa-1', SCHEDULE)]
  // The process stops once the stores have the records, before the ledger says so.
  const flush = stores.flush
  stores.flush = async () => {
    throw new Error('The process stopped.')
  }
  await assert.rejects(adoption.adopt({ migrationId: 'm-1', records }))
  stores.flush = flush
  calls.length = 0
  // The desktop's journal sends it again, to the Studio started afresh.
  const restarted = createEnvironmentAdoption({ dataDir, stores, now: () => 2_000 })
  const again = await restarted.adopt({ migrationId: 'm-1', records })
  assert.deepEqual(
    again.held.map((entry) => entry.id),
    ['ws-1', 'sa-1'],
  )
  assert.deepEqual(again.conflicts, [], 'its own copies, not another way in')
  assert.deepEqual(calls, ['flush'], 'nothing kept a second time')
  const ledger = JSON.parse(readFileSync(join(dataDir, 'environment-adoptions.json'), 'utf8')) as {
    records: Record<string, { pending?: true }>
  }
  assert.equal(ledger.records['workspace:ws-1']?.pending, undefined, 'kept, no longer pending')
})

test('what does not read, does not match its digest, or is already here by another way is reported, not kept', async () => {
  const { adoption, calls, workspaces } = rig()
  workspaces.add('ws-here')
  const tampered = { ...record('workspace', 'ws-2', WORKSPACE), body: { ...WORKSPACE, id: 'ws-2', name: 'other' } }
  const answer = await adoption.adopt({
    migrationId: 'm-1',
    records: [
      tampered,
      record('workspace', 'ws-here', { ...WORKSPACE, id: 'ws-here' }),
      record('workspace', 'ws-3', { ...WORKSPACE, id: 'ws-other' }),
      record('schedule', 'sa-2', { id: 'sa-2' }),
      record('scheduled-message', 'sm-3', {
        workspaceId: 'ws-1',
        agentId: 'a1',
        text: 'with a picture',
        queued: true,
        carries: { images: ['photo.png'] },
      }),
      record('scheduled-message', 'sm-4', { workspaceId: 'ws-1', agentId: 'a1', text: 'no time' }),
      record('pull-request', 'pr-9', { workspaceId: 'ws-1', agentId: 'a1', url: 'https://github.com/o/r/pull/9' }),
    ],
  })
  assert.deepEqual(answer.held, [])
  assert.deepEqual(
    answer.conflicts.map((entry) => `${entry.id}: ${entry.reason}`),
    [
      'ws-2: Its digest does not match its body.',
      'ws-here: A workspace with that id is already here.',
      'ws-3: The workspace record names another id.',
      'sa-2: A scheduled agent has a prompt.',
      'sm-3: It carries pictures or files, which are not handed over yet.',
      'sm-4: A scheduled message says when it goes.',
      'pr-9: Another chat here opened it.',
    ],
  )
  // A refused record is not in the ledger: once what kept it from going in is fixed, it goes in.
  calls.length = 0
  workspaces.delete('ws-here')
  const retried = await adoption.adopt({
    migrationId: 'm-1',
    records: [record('workspace', 'ws-here', { ...WORKSPACE, id: 'ws-here' })],
  })
  assert.deepEqual(retried.held, [{ kind: 'workspace', id: 'ws-here' }])
})

test('two hand-overs at once are kept one after the other, never interleaved', async () => {
  const { adoption, calls } = rig()
  const [a, b] = await Promise.all([
    adoption.adopt({ migrationId: 'm-a', records: [record('workspace', 'ws-a', { ...WORKSPACE, id: 'ws-a' })] }),
    adoption.adopt({ migrationId: 'm-b', records: [record('workspace', 'ws-b', { ...WORKSPACE, id: 'ws-b' })] }),
  ])
  assert.equal(a.held.length + b.held.length, 2)
  assert.deepEqual(calls, ['workspace ws-a', 'flush', 'workspace ws-b', 'flush'])
})
