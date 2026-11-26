import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { testDatabaseAt } from '../../../../tests/studio-database'
import { createTailnetDeviceStore, readTailnetDevicesFile } from './tailnet-devices'

// The devices paired with this Studio are kept in the data folder's database,
// a row each. In memory the store is the authority: a revoke holds at once,
// and is saved behind it.

const scratch = () => mkdtempSync(join(tmpdir(), 'tailnet-devices-'))

const mint = { name: 'android-phone', scopes: ['workspace:read' as const], origin: { kind: 'code' as const, by: null } }

test('a paired device is kept for the next start, and a revoked one stays revoked', async () => {
  const dir = scratch()
  const store = createTailnetDeviceStore({ database: testDatabaseAt(dir) })
  const kept = store.mintDevice(mint as never)
  const revoked = store.mintDevice({ ...mint, name: 'dev-macbook-air' } as never)
  assert.equal(store.revokeDevice(revoked.device.id), true)
  assert.equal(store.authenticate(revoked.deviceToken), null, 'refused from this moment')
  await store.flush()

  const restarted = createTailnetDeviceStore({ database: testDatabaseAt(dir) })
  assert.deepEqual(
    restarted.listDevices().map((device) => device.id),
    [kept.device.id],
  )
  assert.equal(restarted.authenticate(kept.deviceToken)?.id, kept.device.id)
  assert.equal(restarted.authenticate(revoked.deviceToken), null, 'and after a restart')
})

test('a row that does not read is not trusted, and the others still are', async () => {
  const dir = scratch()
  const store = createTailnetDeviceStore({ database: testDatabaseAt(dir) })
  const kept = store.mintDevice(mint as never)
  await store.flush()
  await testDatabaseAt(dir).run('INSERT INTO devices (id, position, body) VALUES (?, 9, ?)', [
    'tnd_broken',
    '{"id":"tnd_broken","name":"x","scopes":["workspace:read"]',
  ])
  const logged: string[] = []
  const restarted = createTailnetDeviceStore({ database: testDatabaseAt(dir), log: (line) => logged.push(line) })
  assert.deepEqual(
    restarted.listDevices().map((device) => device.id),
    [kept.device.id],
  )
  assert.ok(logged.some((line) => /tnd_broken/u.test(line)))
})

test('a file from before the database is read as its store read it: a malformed entry is no grant', () => {
  const device = {
    id: 'tnd_1',
    name: 'android-phone',
    scopes: ['workspace:read'],
    createdAt: '2026-09-01T00:00:00.000Z',
    tokenHash: 'hash',
  }
  const read = readTailnetDevicesFile(JSON.stringify({ version: 1, devices: [device, { id: 'tnd_2', name: 'x' }] }))
  assert.deepEqual(
    read?.map((entry) => [entry.id, entry.origin.kind, entry.node]),
    [['tnd_1', 'unknown', null]],
  )
  assert.equal(readTailnetDevicesFile('{"version":1,"devices":['), null)
})
