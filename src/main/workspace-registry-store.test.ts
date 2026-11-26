import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  openStudioDatabase,
  prepareStudioDatabase,
  STUDIO_DATABASE_FILENAME,
  type StudioDatabase,
} from '../server/db/database'
import { savedRegistry, seedRegistry, testDatabaseAt } from '../../tests/studio-database'
import { createWorkspaceRegistryStore, WORKSPACE_REGISTRY_FILE_NAME } from './workspace-registry-store'
import {
  emptyWorkspaceRegistryFile,
  toWorkspaceRegistryRecord,
  type WorkspaceRegistryFile,
} from '../shared/workspace-registry'
import type { Workspace } from '../shared/workspace'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-store-'))
  dirs.push(dir)
  return dir
}

function workspace(id: string, name: string, revision: number) {
  return toWorkspaceRegistryRecord(
    {
      id,
      name,
      mode: 'standard',
      folderPath: '/repo',
      templateId: 'solo',
      layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
      agents: {},
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      editorState: { openFiles: [], activeFilePath: null },
      createdAt: 1_000,
    } as Workspace,
    revision,
  )
}

function registry(name: string, revision: number, others: string[] = []): WorkspaceRegistryFile {
  return {
    ...emptyWorkspaceRegistryFile(5_000),
    revision,
    workspaces: [workspace('ws-1', name, revision), ...others.map((id) => workspace(id, id, 1))],
    activeWorkspaceId: 'ws-1',
  }
}

/** The database, with each batch it was asked to write counted, and a way to make the next ones fail. */
function counting(database: StudioDatabase) {
  const batches: number[] = []
  let failing = false
  const wrapped: StudioDatabase = {
    ...database,
    readNow: (sql, params) => database.readNow(sql, params),
    batch: async (statements) => {
      batches.push(statements.length)
      if (failing) throw new Error('disk I/O error')
      return database.batch(statements)
    },
  }
  return {
    database: wrapped,
    batches,
    fail: (value: boolean) => {
      failing = value
    },
  }
}

function persistedName(dir: string): unknown {
  return (savedRegistry(dir)?.workspaces[0] as { name?: unknown } | undefined)?.name
}

test('a write whose content matches the last one is no write, whatever its revision', async () => {
  const dir = tempDir()
  const db = counting(testDatabaseAt(dir))
  const store = createWorkspaceRegistryStore({ database: db.database })
  store.write(registry('Alpha', 1))
  await store.flush()
  store.write(registry('Alpha', 2))
  await store.flush()
  assert.equal(db.batches.length, 1, 'no second write for the same content')
})

test('the registry read at start counts as already written', async () => {
  const dir = tempDir()
  seedRegistry(dir, registry('Alpha', 3))
  const db = counting(testDatabaseAt(dir))
  const store = createWorkspaceRegistryStore({ database: db.database })
  assert.equal(store.read().status, 'loaded')

  store.write(registry('Alpha', 4))
  await store.flush()
  assert.equal(db.batches.length, 0)

  store.write(registry('Beta', 5))
  await store.flush()
  assert.equal(persistedName(dir), 'Beta')
})

test('a change writes only the rows that changed', async () => {
  const dir = tempDir()
  const db = counting(testDatabaseAt(dir))
  const store = createWorkspaceRegistryStore({ database: db.database })
  store.write(registry('Alpha', 1, ['ws-2', 'ws-3']))
  await store.flush()
  assert.deepEqual(db.batches, [4], 'the head and three records')

  // A rename touches one record and the head's revision.
  const renamed = registry('Beta', 2, ['ws-2', 'ws-3'])
  renamed.workspaces = [renamed.workspaces[0]!, ...registry('Alpha', 1, ['ws-2', 'ws-3']).workspaces.slice(1)]
  store.write(renamed)
  await store.flush()
  assert.deepEqual(db.batches, [4, 2])

  // Removing a record deletes its row.
  store.write({ ...renamed, revision: 3, workspaces: renamed.workspaces.filter((entry) => entry.id !== 'ws-3') })
  await store.flush()
  assert.deepEqual(
    savedRegistry(dir)?.workspaces.map((entry) => (entry as { id: string }).id),
    ['ws-1', 'ws-2'],
  )
})

test('writes asked for while one is being written are written once, the newest', async () => {
  const dir = tempDir()
  const db = counting(testDatabaseAt(dir))
  const store = createWorkspaceRegistryStore({ database: db.database })
  store.write(registry('Alpha', 1))
  store.write(registry('Beta', 2))
  store.write(registry('Gamma', 3))
  store.write(registry('Delta', 4))
  await store.flush()
  assert.equal(db.batches.length, 2, 'the first, then the newest of those that waited')
  assert.equal(persistedName(dir), 'Delta')
})

test('a change reverted while another is being written ends on what memory holds', async () => {
  const dir = tempDir()
  const store = createWorkspaceRegistryStore({ database: testDatabaseAt(dir) })
  store.write(registry('Alpha', 1))
  store.write(registry('Beta', 2))
  store.write(registry('Alpha', 3))
  await store.flush()
  assert.equal(persistedName(dir), 'Alpha')
})

test('a failed write warns, and the retry of the same content still writes', async () => {
  const dir = tempDir()
  const db = counting(testDatabaseAt(dir))
  const diagnostics: string[] = []
  const store = createWorkspaceRegistryStore({
    database: db.database,
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic.title),
  })
  db.fail(true)
  store.write(registry('Alpha', 1))
  await store.flush()
  assert.deepEqual(diagnostics, ['Workspace registry not persisted'])
  assert.equal(savedRegistry(dir), null)

  db.fail(false)
  store.write(registry('Alpha', 2))
  await store.flush()
  assert.equal(persistedName(dir), 'Alpha', 'the retry of identical content still writes')
})

test('whenWritten settles once the change is committed, with no delay to wait out', async () => {
  const dir = tempDir()
  const store = createWorkspaceRegistryStore({ database: testDatabaseAt(dir) })
  store.write(registry('Alpha', 1))
  store.write(registry('Beta', 2))
  await store.whenWritten()
  assert.equal(persistedName(dir), 'Beta')
})

test('a snooze survives a quit a moment after it: a new process reads it', async () => {
  const dir = tempDir()
  const first = openStudioDatabase(dir, { readers: 1 })
  const store = createWorkspaceRegistryStore({ database: first })
  store.write(registry('Snoozed', 1))
  await store.whenWritten()
  // The process goes away without closing the database: what was committed is in its log.
  const after = openStudioDatabase(dir, { readers: 1 })
  try {
    const outcome = createWorkspaceRegistryStore({ database: after }).read()
    assert.equal(outcome.status, 'loaded')
    assert.equal(outcome.status === 'loaded' ? outcome.file.workspaces[0]?.name : null, 'Snoozed')
  } finally {
    await after.close()
    await first.close()
  }
})

test('none is missing; a registry file the import could not read is unreadable, not an empty list', () => {
  const fresh = tempDir()
  assert.deepEqual(createWorkspaceRegistryStore({ database: testDatabaseAt(fresh) }).read(), { status: 'missing' })

  const damaged = tempDir()
  const connection = prepareStudioDatabase(join(damaged, STUDIO_DATABASE_FILENAME))
  connection.run('INSERT INTO imports (source, imported_at, records, skipped) VALUES (?, 1, 0, 1)', [
    WORKSPACE_REGISTRY_FILE_NAME,
  ])
  connection.close()
  const titles: string[] = []
  const outcome = createWorkspaceRegistryStore({
    database: testDatabaseAt(damaged),
    logDiagnostic: (diagnostic) => titles.push(diagnostic.title),
  }).read()
  assert.equal(outcome.status, 'unreadable')
  assert.deepEqual(titles, ['Workspace registry parse failed'])
})

test('a record row that does not read is dropped by name; the rest load', () => {
  const dir = tempDir()
  seedRegistry(dir, registry('Alpha', 1, ['ws-2']))
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  connection.run("UPDATE chats SET body = '{ torn' WHERE id = 'ws-2'")
  connection.close()
  const outcome = createWorkspaceRegistryStore({ database: testDatabaseAt(dir) }).read()
  assert.equal(outcome.status, 'loaded')
  if (outcome.status !== 'loaded') return
  assert.deepEqual(
    outcome.file.workspaces.map((entry) => entry.id),
    ['ws-1'],
  )
  assert.deepEqual(
    outcome.droppedRecords.map((entry) => entry.id),
    ['ws-2'],
  )
})
