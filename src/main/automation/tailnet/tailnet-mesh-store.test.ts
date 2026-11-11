import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createSecretCipherStandIn as cipher } from '../../../../tests/stubs/secret-cipher'
import { createTailnetMeshStore, LEGACY_TAILNET_MESH_FILENAME, TAILNET_MESH_FILENAME } from './tailnet-mesh-store'
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

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readFile(dir: string): { raw: string; parsed: { version: number; connections: Record<string, unknown>[] } } {
  const raw = readFileSync(join(dir, TAILNET_MESH_FILENAME), 'utf8')
  return { raw, parsed: JSON.parse(raw) }
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

test('pairings stored under the legacy file name are moved to the current one and kept', () => {
  withDir((dir) => {
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }), {
      mode: 0o600,
    })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.deepEqual(
      store.list().map((connection) => connection.id),
      ['tnc_1'],
      'the pairing survives the rename',
    )
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret')
    assert.equal(existsSync(join(dir, LEGACY_TAILNET_MESH_FILENAME)), false, 'no second copy of the tokens')
    const current = join(dir, TAILNET_MESH_FILENAME)
    assert.equal(readFile(dir).parsed.connections[0].id, 'tnc_1')
    if (process.platform !== 'win32') assert.equal(statSync(current).mode & 0o777, 0o600)
  })
})

test('a current file wins over a leftover legacy one', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 2, connections: [] }))
    writeFileSync(join(dir, LEGACY_TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }))
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.deepEqual(store.list(), [])
  })
})

test('a token is sealed on disk and opened again by the next launch', () => {
  withDir((dir) => {
    const first = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    const added = first.add(input)

    const { raw, parsed } = readFile(dir)
    assert.equal(parsed.version, 2)
    assert.doesNotMatch(raw, /mctn_fresh-secret/u, 'the token is never written as plaintext')
    assert.equal('deviceToken' in parsed.connections[0], false)
    assert.equal(typeof parsed.connections[0].sealedToken, 'string')
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, TAILNET_MESH_FILENAME)).mode & 0o777, 0o600)
    }
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'the atomic write leaves no temporary behind',
    )

    const second = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.equal(second.find(added.id)?.deviceToken, 'mctn_fresh-secret')
    assert.deepEqual(second.list(), first.list())
  })
})

test('the public view never carries a token or its ciphertext', () => {
  withDir((dir) => {
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    store.add(input)
    for (const connection of store.list()) {
      assert.equal('deviceToken' in connection, false)
      assert.equal('sealedToken' in connection, false)
    }
  })
})

test('a rewrite reuses the sealed token instead of asking the keychain again', () => {
  withDir((dir) => {
    const keychain = cipher()
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: keychain })
    const added = store.add(input)
    const sealed = readFile(dir).parsed.connections[0].sealedToken
    store.markConnected(added.id)
    store.updateScopes(added.id, ['workspace:read', 'conversation:read'])
    assert.equal(keychain.seals, 1)
    assert.equal(readFile(dir).parsed.connections[0].sealedToken, sealed)
  })
})

test('a plaintext file is rewritten sealed on its first read', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }), {
      mode: 0o600,
    })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret', 'the pairing still works')

    const { raw, parsed } = readFile(dir)
    assert.equal(parsed.version, 2)
    assert.doesNotMatch(raw, /mctn_plaintext-secret/u, 'no plaintext is left behind after the first read')
    assert.equal(parsed.connections[0].id, 'tnc_1')
    assert.equal(parsed.connections[0].machineName, 'mac-mini')

    const next = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.equal(next.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret', 'and the next launch opens it')
  })
})

test('without encryption a new pairing lives in memory only', () => {
  withDir((dir) => {
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher({ value: false }) })
    const added = store.add(input)
    assert.equal(store.find(added.id)?.deviceToken, 'mctn_fresh-secret', 'usable for this session')

    const { raw, parsed } = readFile(dir)
    assert.doesNotMatch(raw, /mctn_fresh-secret/u)
    assert.deepEqual(parsed.connections, [], 'nothing about it reaches the disk')

    const next = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher({ value: false }) })
    assert.deepEqual(next.list(), [], 'and it does not survive a restart')
  })
})

test('with no cipher installed the store falls back to memory only rather than plaintext', () => {
  withDir((dir) => {
    // No `cipher` option and no platform installed in a test run: no cipher.
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir })
    store.add(input)
    assert.doesNotMatch(readFile(dir).raw, /mctn_fresh-secret/u)
  })
})

test('without encryption a plaintext file loses its tokens from disk but keeps them for the session', () => {
  withDir((dir) => {
    writeFileSync(join(dir, TAILNET_MESH_FILENAME), JSON.stringify({ version: 1, connections: [stored] }))
    const logged: string[] = []
    const store = createTailnetMeshStore({
      resolveUserDataDir: () => dir,
      cipher: cipher({ value: false }),
      log: (line) => logged.push(line),
    })
    assert.equal(store.find('tnc_1')?.deviceToken, 'mctn_plaintext-secret')
    assert.doesNotMatch(readFile(dir).raw, /mctn_plaintext-secret/u)
    assert.ok(
      logged.some((line) => /pair those machines again/u.test(line)),
      'the log says why the pairing will not survive',
    )
  })
})

test('a sealed record this launch cannot open is kept for a later one', () => {
  withDir((dir) => {
    const available = { value: true }
    const first = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher(available) })
    const kept = first.add(input)

    // The keychain is unavailable for one launch, which still makes a change.
    available.value = false
    const locked = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher(available) })
    assert.deepEqual(locked.list(), [], 'what cannot be opened is not offered')
    locked.add({ ...input, deviceId: 'dev_10', deviceToken: 'mctn_session-only' })
    assert.doesNotMatch(readFile(dir).raw, /mctn_session-only/u)

    available.value = true
    const later = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher(available) })
    assert.equal(later.find(kept.id)?.deviceToken, 'mctn_fresh-secret', 'the sealed pairing survived that launch')
    assert.equal(later.list().length, 1)
  })
})

test('a file that cannot be read is not written over by the next pairing', () => {
  if (process.platform === 'win32') return
  withDir((dir) => {
    const path = join(dir, TAILNET_MESH_FILENAME)
    const original = JSON.stringify({ version: 1, connections: [stored] })
    writeFileSync(path, original, { mode: 0o000 })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    store.add(input)
    assert.equal(store.list().length, 1, 'the new pairing works for the session')
    chmodSync(path, 0o600)
    assert.equal(readFileSync(path, 'utf8'), original, 'every stored pairing is still on disk')
  })
})

test('a file that is not valid JSON is kept aside before the next pairing is written', () => {
  withDir((dir) => {
    const path = join(dir, TAILNET_MESH_FILENAME)
    writeFileSync(path, '{"version":1,"connections":[', { mode: 0o600 })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    store.add(input)
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${TAILNET_MESH_FILENAME}.invalid-`))
    assert.equal(aside.length, 1)
    assert.equal(readFileSync(join(dir, aside[0]!), 'utf8'), '{"version":1,"connections":[')
    assert.equal(readFile(dir).parsed.connections.length, 1)
  })
})

test('an invalid file deleted since it was read leaves the next pairing free to write a new one', () => {
  withDir((dir) => {
    const path = join(dir, TAILNET_MESH_FILENAME)
    writeFileSync(path, '{"version":1,"connections":[', { mode: 0o600 })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    unlinkSync(path)
    store.add(input)
    assert.equal(readFile(dir).parsed.connections.length, 1)
  })
})

test('an invalid file that cannot be moved aside is left alone, and pairing still works', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  withDir((dir) => {
    const path = join(dir, TAILNET_MESH_FILENAME)
    writeFileSync(path, '{"version":1,"connections":[', { mode: 0o600 })
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    chmodSync(dir, 0o500)
    try {
      store.add(input)
      store.add({ ...input, deviceId: 'dev_10' })
    } finally {
      chmodSync(dir, 0o700)
    }
    assert.equal(store.list().length, 2, 'both pairings work for the session')
    assert.equal(readFileSync(path, 'utf8'), '{"version":1,"connections":[')
  })
})

test('the environment id a machine says is kept across a restart and a rename, and never erased by silence', () => {
  withDir((dir) => {
    const first = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    const added = first.add(input)
    assert.equal(added.environmentId, undefined)
    const id = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
    assert.equal(first.noteEnvironment(added.id, id), true)
    assert.equal(first.noteEnvironment(added.id, id), false, 'the same id again is not news')
    // An older build's identity says none: what a newer one said stays.
    assert.equal(first.noteEnvironment(added.id, null), false)
    assert.equal(first.noteEnvironment(added.id, 'not:an-id'), false)
    assert.equal(first.list()[0]?.environmentId, id)

    const second = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.equal(second.list()[0]?.environmentId, id)

    // Reinstalled over there: the pairing now reaches another Studio.
    const replaced = '0f8e2b1c-3a4d-4e5f-8a9b-1c2d3e4f5a6b'
    assert.equal(second.noteEnvironment(added.id, replaced), true)
    assert.equal(
      createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() }).list()[0]?.environmentId,
      replaced,
    )
    assert.equal(second.noteEnvironment('tnc_unknown', id), false)
  })
})

test('a stored environment id that is not one is dropped on read, not trusted', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, TAILNET_MESH_FILENAME),
      JSON.stringify({ version: 1, connections: [{ ...stored, environmentId: '../../etc' }] }),
    )
    const store = createTailnetMeshStore({ resolveUserDataDir: () => dir, cipher: cipher() })
    assert.equal(store.list()[0]?.environmentId, undefined)
  })
})

test('the paired list is re-read after a pairing, a forgetting or an answer, and not for a check in flight', () => {
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
    meshListChanged({ kind: 'machine-reachability', revision: 1, ...reachability, checking: false, reachable: true }),
    true,
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
