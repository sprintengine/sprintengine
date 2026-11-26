import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { testDatabaseAt } from '../../../../tests/studio-database'
import { createSecretCipherStandIn as cipher } from '../../../../tests/stubs/secret-cipher'
import { STUDIO_DATABASE_FILENAME } from '../../../server/db/database'
import { createTailnetMeshStore, readTailnetMeshFile, type TailnetMeshStore } from './tailnet-mesh-store'
import { meshListChanged } from '../../../shared/tailnet-mesh'

const stored = {
  id: 'tnc_1',
  machineName: 'mac-mini',
  endpoint: '100.64.0.2:8443',
  deviceId: 'dev_1',
  deviceName: 'dev-macbook-air',
  deviceToken: 'mctn_plaintext-secret',
  scopes: ['workspace:read'],
  pairedAt: '2026-09-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

const scratch = () => mkdtempSync(join(tmpdir(), 'mesh-store-'))

/** The connections' rows once `store` has saved, as the database keeps them. */
async function saved(dir: string, store: TailnetMeshStore): Promise<{ raw: string; rows: Record<string, unknown>[] }> {
  await store.flush()
  const rows = await testDatabaseAt(dir).all<{ body: string }>('SELECT body FROM mesh_links ORDER BY position')
  return {
    raw: rows.map((row) => row.body).join('\n'),
    rows: rows.map((row) => JSON.parse(row.body) as Record<string, unknown>),
  }
}

const input = {
  machineName: 'build-box',
  endpoint: '100.64.0.9:8443',
  deviceId: 'dev_9',
  deviceName: 'mac-mini',
  deviceToken: 'mctn_fresh-secret',
  scopes: ['workspace:read' as const],
  pairedVia: 'link' as const,
}

test('a token is sealed in the database and opened again by the next launch', async () => {
  const dir = scratch()
  const first = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher() })
  const added = first.add(input)

  const { raw, rows } = await saved(dir, first)
  assert.doesNotMatch(raw, /mctn_fresh-secret/u, 'the token is never written as plaintext')
  assert.equal('deviceToken' in rows[0]!, false)
  assert.equal(typeof rows[0]!.sealedToken, 'string')
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, STUDIO_DATABASE_FILENAME)).mode & 0o777, 0o600)

  const second = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher() })
  assert.equal(second.find(added.id)?.deviceToken, 'mctn_fresh-secret')
  assert.deepEqual(second.list(), first.list())
})

test('the public view never carries a token or its ciphertext', () => {
  const store = createTailnetMeshStore({ database: testDatabaseAt(scratch()), cipher: cipher() })
  store.add(input)
  for (const connection of store.list()) {
    assert.equal('deviceToken' in connection, false)
    assert.equal('sealedToken' in connection, false)
  }
})

test('a rewrite reuses the sealed token instead of asking the keychain again', async () => {
  const dir = scratch()
  const keychain = cipher()
  const store = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: keychain })
  const added = store.add(input)
  const sealed = (await saved(dir, store)).rows[0]!.sealedToken
  store.markConnected(added.id)
  store.updateScopes(added.id, ['workspace:read', 'conversation:read'])
  assert.equal(keychain.seals, 1)
  assert.equal((await saved(dir, store)).rows[0]!.sealedToken, sealed)
})

test('without encryption a new pairing lives in memory only', async () => {
  const dir = scratch()
  const store = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher({ value: false }) })
  const added = store.add(input)
  assert.equal(store.find(added.id)?.deviceToken, 'mctn_fresh-secret', 'usable for this session')
  const { raw, rows } = await saved(dir, store)
  assert.doesNotMatch(raw, /mctn_fresh-secret/u)
  assert.deepEqual(rows, [], 'nothing about it reaches the disk')
  const next = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher({ value: false }) })
  assert.deepEqual(next.list(), [], 'and it does not survive a restart')
})

test('with no cipher installed the store falls back to memory only rather than plaintext', async () => {
  const dir = scratch()
  // No `cipher` option and no platform installed in a test run: no cipher.
  const store = createTailnetMeshStore({ database: testDatabaseAt(dir) })
  store.add(input)
  assert.doesNotMatch((await saved(dir, store)).raw, /mctn_fresh-secret/u)
})

test('a sealed record this launch cannot open is kept for a later one', async () => {
  const dir = scratch()
  const available = { value: true }
  const first = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher(available) })
  const kept = first.add(input)
  await first.flush()

  // The keychain is unavailable for one launch, which still makes a change.
  available.value = false
  const locked = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher(available) })
  assert.deepEqual(locked.list(), [], 'what cannot be opened is not offered')
  locked.add({ ...input, deviceId: 'dev_10', deviceToken: 'mctn_session-only' })
  assert.doesNotMatch((await saved(dir, locked)).raw, /mctn_session-only/u)

  available.value = true
  const later = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher(available) })
  assert.equal(later.find(kept.id)?.deviceToken, 'mctn_fresh-secret', 'the sealed pairing survived that launch')
  assert.equal(later.list().length, 1)
})

test('a file from before the database: sealed pairings are imported, a plaintext token never is', () => {
  const sealed = { ...stored, deviceToken: undefined, id: 'tnc_2', sealedToken: 'c2VhbGVk' }
  const read = readTailnetMeshFile(JSON.stringify({ version: 2, connections: [stored, sealed, { id: 'half' }] }))
  assert.deepEqual(
    read?.sealed.map((entry) => entry.id),
    ['tnc_2'],
  )
  assert.equal(read?.plaintext, 1)
  assert.equal(readTailnetMeshFile('{"version":1,"connections":['), null)
})

test('the environment id a machine says is kept across a restart and a rename, and never erased by silence', async () => {
  const dir = scratch()
  const first = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher() })
  const added = first.add(input)
  assert.equal(added.environmentId, undefined)
  const id = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
  assert.equal(first.noteEnvironment(added.id, id), true)
  assert.equal(first.noteEnvironment(added.id, id), false, 'the same id again is not news')
  // An older build's identity says none: what a newer one said stays.
  assert.equal(first.noteEnvironment(added.id, null), false)
  assert.equal(first.noteEnvironment(added.id, 'not:an-id'), false)
  assert.equal(first.list()[0]?.environmentId, id)
  await first.flush()

  const second = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher() })
  assert.equal(second.list()[0]?.environmentId, id)

  // Reinstalled over there: the pairing now reaches another Studio.
  const replaced = '0f8e2b1c-3a4d-4e5f-8a9b-1c2d3e4f5a6b'
  assert.equal(second.noteEnvironment(added.id, replaced), true)
  await second.flush()
  assert.equal(
    createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: cipher() }).list()[0]?.environmentId,
    replaced,
  )
  assert.equal(second.noteEnvironment('tnc_unknown', id), false)
})

test('a stored environment id that is not one is dropped on read, not trusted', async () => {
  const dir = scratch()
  const keychain = cipher()
  const sealedToken = keychain.seal('mctn_x').toString('base64')
  await testDatabaseAt(dir).run('INSERT INTO mesh_links (id, position, body) VALUES (?, 0, ?)', [
    'tnc_1',
    JSON.stringify({ ...stored, deviceToken: undefined, sealedToken, environmentId: '../../etc' }),
  ])
  const store = createTailnetMeshStore({ database: testDatabaseAt(dir), cipher: keychain })
  assert.equal(store.list()[0]?.environmentId, undefined)
  assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_x')
})

test('the paired list is re-read after a pairing, a forgetting or a machine saying which Studio it is', () => {
  const reachability = {
    connectionId: 'tnc_1',
    machineName: 'mac-mini',
    unauthorized: false,
    checkedAt: 1,
    lastReachedAt: 1,
    detail: null,
  }
  const connection = { ...stored, scopes: ['workspace:read' as const], pairedVia: 'link' as const }
  assert.equal(meshListChanged({ kind: 'machine-paired', revision: 1, connection }), true)
  assert.equal(
    meshListChanged({ kind: 'machine-forgotten', revision: 1, connectionId: 'tnc_1', machineName: 'mac-mini' }),
    true,
  )
  assert.equal(
    meshListChanged({ kind: 'machine-identified', revision: 1, connectionId: 'tnc_1', environmentId: 'env-1' }),
    true,
  )
  // An answer by itself changes nothing in the list: the id it carried is news only once.
  assert.equal(
    meshListChanged({ kind: 'machine-reachability', revision: 1, ...reachability, checking: false, reachable: true }),
    false,
  )
  assert.equal(
    meshListChanged({ kind: 'machine-reachability', revision: 1, ...reachability, checking: true, reachable: true }),
    false,
  )
  assert.equal(
    meshListChanged({ kind: 'machine-reachability', revision: 1, ...reachability, checking: false, reachable: false }),
    false,
  )
  assert.equal(
    meshListChanged({
      kind: 'remote-changed',
      revision: 1,
      connectionId: 'tnc_1',
      machineName: 'mac-mini',
      what: 'workspaces',
    }),
    false,
  )
})
