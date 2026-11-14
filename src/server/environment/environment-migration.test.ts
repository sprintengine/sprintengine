import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import {
  MAX_ADOPTED_FILES,
  MAX_ADOPTED_PART_BYTES,
  STUDIO_MAX_UPLOAD_BYTES,
  type StudioAdoptedRecordKind,
  type StudioAdoptResult,
} from '../../../packages/studio-protocol/src/public'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { adoptedRecordDigest } from './environment-adoption'
import {
  createEnvironmentMigration,
  type EnvironmentMigrationStores,
  type MigratingRecord,
} from './environment-migration'

// The hand-over journal: what this desktop kept for an SSH machine's chats is
// written aside in the machine's spelling, listed, and only then taken out of
// the live stores; delivered once the machine is reachable, with the pictures
// and files a held message carries staged beside it; retired after. A machine
// never reached keeps its records waiting across restarts.

const ROUTE = 'ssh:build-box'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Sent = { kind: StudioAdoptedRecordKind; id: string; digest: string; body: Record<string, unknown> }

function rig(
  records: MigratingRecord[],
  options: {
    dataDir?: string
    reachable?: boolean
    /** How the machine answers a call's records; held, all of them, unless said. */
    answer?: (sent: Sent[]) => Partial<StudioAdoptResult>
    chunkBytes?: number
  } = {},
) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'environment-migration-'))
  if (!options.dataDir) dirs.push(dataDir)
  const live = new Map(records.map((record) => [`${record.kind}:${record.id}`, record]))
  const released: string[] = []
  let failRelease = false
  const stores: EnvironmentMigrationStores = {
    async collect(workspacesOf) {
      return [...live.values()].filter((record) => record.kind !== 'workspace' || workspacesOf(record.route))
    },
    async release(taken) {
      if (failRelease) throw new Error('crashed before the stores were rewritten')
      for (const record of taken) {
        released.push(`${record.kind}:${record.id}`)
        if (record.kind !== 'workspace') live.delete(`${record.kind}:${record.id}`)
      }
    },
  }
  const asked: Array<{ method: string; params: Record<string, unknown> }> = []
  let reachable = options.reachable ?? true
  let uploads = 0
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      asked.push({ method, params })
      if (method === 'uploads.begin') return { uploadId: `up-${++uploads}`, chunkBytes: options.chunkBytes ?? 4 }
      if (method === 'uploads.append') return { received: 0 }
      if (method === 'environment.adopt') {
        const sent = params.records as Sent[]
        for (const each of sent) assert.equal(each.digest, adoptedRecordDigest(each.body), 'each digest is of its body')
        return { held: sent.map(({ kind, id }) => ({ kind, id })), conflicts: [], ...options.answer?.(sent) }
      }
      throw new Error(`not served: ${method}`)
    },
  } as unknown as StudioClient
  const clients: EnvironmentClients = {
    async clientFor() {
      return reachable
        ? { ok: true, client, name: 'build-box' }
        : { ok: false, code: 'unavailable', message: 'build-box is not connected.' }
    },
    onConnected: () => () => undefined,
  }
  const refusals: Array<{ route: string; ids: string[] }> = []
  const migration = createEnvironmentMigration({
    dataDir,
    stores,
    clients,
    onRefused: (route, refused) => refusals.push({ route, ids: refused.map((each) => each.id) }),
  })
  return {
    dataDir,
    migration,
    live,
    released,
    asked,
    refusals,
    failRelease: (fail: boolean) => (failRelease = fail),
    setReachable: (value: boolean) => (reachable = value),
  }
}

const journalOf = (dataDir: string) =>
  JSON.parse(readFileSync(join(dataDir, 'environment-migration.json'), 'utf8')) as {
    environments: Record<string, { state: string; migrationId: string; records: Array<{ id: string }> }>
  }

const WORKSPACE: MigratingRecord = {
  route: ROUTE,
  kind: 'workspace',
  id: 'ws-1',
  body: {
    id: 'ws-1',
    name: 'repo',
    folderPath: 'ssh://build-box/home/dev/repo',
    environment: { kind: 'ssh', id: 'build-box', label: 'build-box' },
    agents: {},
  },
}
const SCHEDULE: MigratingRecord = {
  route: ROUTE,
  kind: 'schedule',
  id: 'sa-1',
  body: { id: 'sa-1', folderPath: 'ssh://build-box/home/dev/repo', hostId: null, nextRunAt: 5, prompt: 'Triage' },
}

test('a plan writes the copies aside, then the journal, then empties the live stores; a delivery hands them over plain', async () => {
  const { dataDir, migration, live, released, asked } = rig([WORKSPACE, SCHEDULE])
  await migration.plan()
  const journal = journalOf(dataDir)
  assert.equal(journal.environments[ROUTE]?.state, 'planned')
  assert.equal((statSync(join(dataDir, 'environment-migration.json')).mode & 0o777).toString(8), '600')
  assert.deepEqual(released, ['workspace:ws-1', 'schedule:sa-1'])
  assert.ok(live.has('workspace:ws-1'), "a workspace record stays, as the machine's copy")
  assert.ok(!live.has('schedule:sa-1'))
  assert.equal(migration.handedOver(ROUTE), false, 'not until it is delivered')

  assert.equal(await migration.deliver(ROUTE), true)
  const adopt = asked.find((entry) => entry.method === 'environment.adopt')?.params as {
    migrationId: string
    records: Array<{ kind: string; body: Record<string, unknown> }>
  }
  assert.equal(adopt.migrationId, journal.environments[ROUTE]?.migrationId)
  const workspace = adopt.records.find((entry) => entry.kind === 'workspace')?.body
  assert.equal(workspace?.folderPath, '/home/dev/repo', "in the machine's spelling")
  assert.equal(workspace?.environment, undefined, 'nothing that says where it lives')
  const schedule = adopt.records.find((entry) => entry.kind === 'schedule')?.body
  assert.deepEqual(schedule, { id: 'sa-1', folderPath: '/home/dev/repo', prompt: 'Triage' })
  assert.equal(journalOf(dataDir).environments[ROUTE]?.state, 'retired')
  assert.ok(existsSync(join(dataDir, 'environment-migration', 'delivered', adopt.migrationId)))
  assert.ok(!existsSync(join(dataDir, 'environment-migration', 'pending', adopt.migrationId)))
  assert.equal(migration.handedOver(ROUTE), true)

  // Handed over once: the machine's copies here are never planned again.
  await migration.plan()
  assert.equal(released.length, 2)
})

test('a held message goes with its picture, staged through uploads.* and named by its digest', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'held-picture-'))
  dirs.push(folder)
  const path = join(folder, '0')
  writeFileSync(path, 'png bytes')
  const message: MigratingRecord = {
    route: ROUTE,
    kind: 'scheduled-message',
    id: 'sm-1',
    body: { id: 'sm-1', workspaceId: 'ws-1', agentId: 'a1', text: 'look', queued: true, sendAt: 1, createdAt: 1 },
    carried: { images: [{ path, name: 'shot.png', mediaType: 'image/png' }] },
  }
  const { migration, asked } = rig([message])
  await migration.plan()
  // Its picture's copy is the hand-over's: the live one may go with the message.
  rmSync(path)
  assert.equal(await migration.deliver(ROUTE), true)
  const begin = asked.find((entry) => entry.method === 'uploads.begin')?.params
  assert.deepEqual(begin, { mediaType: 'image/png', byteLength: 9, name: 'shot.png', purpose: 'picture' })
  const appended = asked.filter((entry) => entry.method === 'uploads.append').map((entry) => entry.params.offset)
  assert.deepEqual(appended, [0, 4, 8])
  const adopt = asked.find((entry) => entry.method === 'environment.adopt')?.params as {
    records: Array<{ body: { carried: { images: Array<{ sha256: string }> } } }>
    files: Array<{ uploadId: string; digest: string }>
  }
  const sha256 = createHash('sha256').update('png bytes').digest('hex')
  assert.equal(adopt.records[0]?.body.carried.images[0]?.sha256, sha256)
  assert.deepEqual(adopt.files, [{ uploadId: 'up-1', digest: sha256 }])
})

test('a machine never reached keeps its records waiting across a restart, and they go once it is', async () => {
  const first = rig([SCHEDULE], { reachable: false })
  await first.migration.plan()
  assert.equal(await first.migration.deliver(ROUTE), false)
  assert.deepEqual(first.migration.waiting(), [ROUTE])
  // Restarted: the live store no longer has it; the journal does.
  const again = rig([], { dataDir: first.dataDir, reachable: true })
  await again.migration.plan()
  assert.equal(await again.migration.deliver(ROUTE), true)
  const adopt = again.asked.find((entry) => entry.method === 'environment.adopt')?.params as {
    records: Array<{ id: string }>
  }
  assert.deepEqual(
    adopt.records.map((entry) => entry.id),
    ['sa-1'],
  )
})

test('a crash after the journal but before the stores were emptied takes them out on the next plan, once', async () => {
  const run = rig([SCHEDULE])
  run.failRelease(true)
  await assert.rejects(run.migration.plan())
  assert.ok(run.live.has('schedule:sa-1'), 'still in its live store')
  run.failRelease(false)
  await run.migration.plan()
  assert.ok(!run.live.has('schedule:sa-1'))
  const listed = journalOf(run.dataDir).environments[ROUTE]?.records ?? []
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ['sa-1'],
    'listed once',
  )
  const pending = join(
    run.dataDir,
    'environment-migration',
    'pending',
    journalOf(run.dataDir).environments[ROUTE]!.migrationId,
  )
  assert.equal(readdirSync(pending).filter((name) => name.endsWith('.json') && name !== 'route.json').length, 1)
})

/** A held message carrying one picture of its own, written to `folder`. */
function heldWithPicture(folder: string, index: number, bytes: string | Buffer): MigratingRecord {
  const path = join(folder, `picture-${index}`)
  writeFileSync(path, bytes)
  return {
    route: ROUTE,
    kind: 'scheduled-message',
    id: `sm-${index}`,
    body: {
      id: `sm-${index}`,
      workspaceId: 'ws-1',
      agentId: 'a1',
      text: `look ${index}`,
      queued: true,
      sendAt: 1,
      createdAt: 1,
    },
    carried: { images: [{ path, name: `${index}.png`, mediaType: 'image/png' }] },
  }
}

const adoptCalls = (asked: Array<{ method: string; params: Record<string, unknown> }>) =>
  asked
    .filter((entry) => entry.method === 'environment.adopt')
    .map((entry) => entry.params as { records: Sent[]; files?: Array<{ uploadId: string; digest: string }> })

test('a hand-over carrying more files than one call stages goes in calls of at most that many, and all of it lands', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'many-pictures-'))
  dirs.push(folder)
  const messages = Array.from({ length: 20 }, (_unused, index) => heldWithPicture(folder, index, `picture ${index}`))
  const { dataDir, migration, asked } = rig(messages, { chunkBytes: 1024 })
  await migration.plan()
  assert.equal(await migration.deliver(ROUTE), true)
  const calls = adoptCalls(asked).filter((call) => call.records.length > 0)
  assert.ok(calls.length >= 2, 'more than one call')
  for (const call of calls)
    assert.ok((call.files?.length ?? 0) <= MAX_ADOPTED_FILES, 'no call stages more than one may')
  assert.equal(
    calls.reduce((total, call) => total + call.records.length, 0),
    20,
  )
  assert.equal(journalOf(dataDir).environments[ROUTE]?.state, 'retired')
})

test('a carried file larger than an upload goes ahead in parts, and its record names them', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'large-file-'))
  dirs.push(folder)
  const large = Buffer.alloc(STUDIO_MAX_UPLOAD_BYTES + 10, 7)
  const { migration, asked } = rig([heldWithPicture(folder, 1, large)], { chunkBytes: STUDIO_MAX_UPLOAD_BYTES })
  await migration.plan()
  assert.equal(await migration.deliver(ROUTE), true)
  const calls = adoptCalls(asked)
  const withRecord = calls.find((call) => call.records.length > 0)!
  assert.equal(withRecord.files, undefined, 'not staged whole')
  const image = (withRecord.records[0]!.body.carried as { images: Array<{ sha256: string; parts?: string[] }> })
    .images[0]!
  assert.equal(image.sha256, createHash('sha256').update(large).digest('hex'))
  assert.deepEqual(image.parts, [
    createHash('sha256').update(large.subarray(0, MAX_ADOPTED_PART_BYTES)).digest('hex'),
    createHash('sha256').update(large.subarray(MAX_ADOPTED_PART_BYTES)).digest('hex'),
  ])
  const staged = calls.filter((call) => call.records.length === 0).flatMap((call) => call.files ?? [])
  assert.deepEqual(
    staged.map((file) => file.digest),
    image.parts,
    'its parts staged ahead of it',
  )
})

test('what the machine did not take stays planned and goes again; what it keeps its own copy of is done with', async () => {
  let refuse = true
  const message: MigratingRecord = {
    route: ROUTE,
    kind: 'scheduled-message',
    id: 'sm-1',
    body: { id: 'sm-1', workspaceId: 'ws-1', agentId: 'a1', text: 'later', sendAt: 5, createdAt: 1 },
  }
  const { dataDir, migration, asked, refusals } = rig([WORKSPACE, SCHEDULE, message], {
    answer: (sent) => ({
      held: sent
        .filter((each) => each.id === 'ws-1' || (!refuse && each.id === 'sa-1'))
        .map(({ kind, id }) => ({ kind, id })),
      conflicts: sent
        .filter((each) => each.id === 'sm-1')
        .map(({ kind, id }) => ({ kind, id, reason: 'This Studio keeps its own.' })),
      refused:
        refuse && sent.some((each) => each.id === 'sa-1')
          ? [{ kind: 'schedule', id: 'sa-1', reason: 'A picture its prompt names did not arrive whole.' }]
          : [],
    }),
  })
  await migration.plan()
  assert.equal(await migration.deliver(ROUTE), true, 'the machine took what it would')
  const entry = journalOf(dataDir).environments[ROUTE] as { state: string; records: Array<{ id: string }> }
  assert.equal(entry.state, 'planned', 'not retired while something waits')
  assert.deepEqual(
    entry.records.map((record) => record.id),
    ['sa-1'],
    'only what was not taken waits',
  )
  assert.deepEqual(migration.waiting(), [ROUTE])
  assert.equal(migration.handedOver(ROUTE), true, 'its workspace was taken, so the replicas follow')
  assert.deepEqual(refusals, [{ route: ROUTE, ids: ['sa-1'] }], 'the person is told')

  // The next connect sends only that one, under a call of its own.
  refuse = false
  const before = adoptCalls(asked).length
  assert.equal(await migration.deliver(ROUTE), true)
  const again = adoptCalls(asked).slice(before)
  assert.deepEqual(
    again.flatMap((call) => call.records.map((record) => record.id)),
    ['sa-1'],
  )
  assert.equal(journalOf(dataDir).environments[ROUTE]?.state, 'retired')
  assert.deepEqual(migration.waiting(), [])
})

test('a journal that cannot be read is rebuilt from the copies waiting aside, and copies no journal lists go', async () => {
  const first = rig([SCHEDULE], { reachable: false })
  await first.migration.plan()
  const migrationId = journalOf(first.dataDir).environments[ROUTE]!.migrationId
  // A plan that stopped before its journal: copies aside, listed nowhere.
  const orphan = join(first.dataDir, 'environment-migration', 'pending', 'orphan-1')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'schedule-x.json'), '{}')
  writeFileSync(join(first.dataDir, 'environment-migration.json'), '{"v":1,"environments":')
  const again = rig([], { dataDir: first.dataDir })
  await again.migration.plan()
  assert.deepEqual(again.migration.waiting(), [ROUTE], 'what waited still waits')
  assert.equal(journalOf(first.dataDir).environments[ROUTE]?.migrationId, migrationId)
  assert.ok(!existsSync(orphan), 'a copy no journal lists is swept')
  assert.ok(
    readdirSync(first.dataDir).some((name) => name.startsWith('environment-migration.json.unreadable-')),
    'the unreadable journal is kept aside',
  )
  assert.equal(await again.migration.deliver(ROUTE), true)
  assert.deepEqual(
    adoptCalls(again.asked).flatMap((call) => call.records.map((record) => record.id)),
    ['sa-1'],
  )
})

test('a journal there but unreadable stops the plan: nothing is swept or released, and the schedulers stay held', async () => {
  const first = rig([SCHEDULE], { reachable: false })
  await first.migration.plan()
  const journalPath = join(first.dataDir, 'environment-migration.json')
  const kept = readFileSync(journalPath, 'utf8')
  const pending = join(
    first.dataDir,
    'environment-migration',
    'pending',
    journalOf(first.dataDir).environments[ROUTE]!.migrationId,
  )
  // Restarted with the journal there but not readable as a file (an I/O
  // failure, not "no journal yet"), and another record in a live store.
  rmSync(journalPath)
  mkdirSync(journalPath)
  const again = rig([{ ...SCHEDULE, id: 'sa-2', body: { ...SCHEDULE.body, id: 'sa-2' } }], { dataDir: first.dataDir })
  let released = false
  void again.migration.planned.then(() => (released = true))
  await assert.rejects(again.migration.plan(), { name: 'EnvironmentMigrationUnreadable' })
  assert.ok(existsSync(pending), 'the copies waiting aside are not swept')
  assert.equal(again.released.length, 0, 'nothing taken out of the live stores')
  assert.equal(await again.migration.deliver(ROUTE).catch(() => false), false, 'nothing handed over')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(released, false, 'the schedulers are not let go')
  // Readable again: the next plan finishes, and lets them go.
  rmSync(journalPath, { recursive: true })
  writeFileSync(journalPath, kept)
  await again.migration.plan()
  await again.migration.planned
  assert.deepEqual(
    journalOf(first.dataDir).environments[ROUTE]!.records.map((entry) => entry.id),
    ['sa-1', 'sa-2'],
  )
})

test('a rebuild that cannot read the copies waiting aside stops, and one whose route is lost keeps its copies', async () => {
  const first = rig([SCHEDULE], { reachable: false })
  await first.migration.plan()
  const journalPath = join(first.dataDir, 'environment-migration.json')
  writeFileSync(journalPath, '{"v":1,"environments":')
  // A folder of copies that cannot be listed (here, a file where a folder should be).
  const blocked = join(first.dataDir, 'environment-migration', 'pending', 'blocked-1')
  writeFileSync(blocked, '')
  const stopped = rig([], { dataDir: first.dataDir })
  await assert.rejects(stopped.migration.plan(), { name: 'EnvironmentMigrationUnreadable' })
  assert.ok(existsSync(journalPath), 'the journal stays where it was')
  rmSync(blocked)
  // A folder of real copies whose route file is gone: no machine to send them to, kept for the owner.
  const lost = join(first.dataDir, 'environment-migration', 'pending', 'lost-1')
  mkdirSync(lost, { recursive: true })
  writeFileSync(
    join(lost, 'schedule-y.json'),
    JSON.stringify({ kind: 'schedule', id: 'sa-9', digest: 'd', body: {}, files: [] }),
  )
  const again = rig([], { dataDir: first.dataDir })
  await again.migration.plan()
  assert.deepEqual(again.migration.waiting(), [ROUTE])
  assert.ok(existsSync(join(lost, 'schedule-y.json')), 'copies with no route are kept aside, not swept')
})
