import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
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

function rig(records: MigratingRecord[], options: { dataDir?: string; reachable?: boolean } = {}) {
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
      if (method === 'uploads.begin') return { uploadId: `up-${++uploads}`, chunkBytes: 4 }
      if (method === 'uploads.append') return { received: 0 }
      if (method === 'environment.adopt') {
        const sent = params.records as Array<{ kind: string; id: string; digest: string; body: unknown }>
        for (const each of sent) assert.equal(each.digest, adoptedRecordDigest(each.body), 'each digest is of its body')
        return { held: sent.map(({ kind, id }) => ({ kind, id })), conflicts: [] }
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
  const migration = createEnvironmentMigration({ dataDir, stores, clients })
  return {
    dataDir,
    migration,
    live,
    released,
    asked,
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
  assert.equal(readdirSync(pending).filter((name) => name.endsWith('.json')).length, 1)
})
