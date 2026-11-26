// A data folder's database for a test: opened in a scratch folder of its own
// (or the one given), with one reader, and closed when the test that opened
// it ends, or with the file when it was opened outside a test.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, onTestFinished } from 'vitest'

import { keepExtensionApprovalsIn } from '../src/main/modules/extension-approvals'
import {
  openStudioDatabase,
  prepareStudioDatabase,
  STUDIO_DATABASE_FILENAME,
  type StudioDatabase,
} from '../src/server/db/database'
import type { RecordTableName } from '../src/server/db/record-table'
import { createSnapshotStorage, type SnapshotStorage, type SnapshotStoreName } from '../src/server/db/snapshot-storage'

const outsideTests: StudioDatabase[] = []
afterAll(async () => {
  await Promise.all(outsideTests.splice(0).map((database) => database.close()))
})

export function openTestDatabase(dataDir: string = mkdtempSync(join(tmpdir(), 'se-db-'))): StudioDatabase {
  const database = openStudioDatabase(dataDir, { readers: 1 })
  try {
    onTestFinished(() => database.close())
  } catch {
    outsideTests.push(database)
  }
  return database
}

const byFolder = new Map<string, StudioDatabase>()

/**
 * The one database of a data folder in this test: a store made again over
 * the same folder (a restart) reads what the one before it saved.
 */
export function testDatabaseAt(dataDir: string): StudioDatabase {
  const key = resolve(dataDir)
  const open = byFolder.get(key)
  if (open) return open
  const database = openTestDatabase(dataDir)
  byFolder.set(key, database)
  const close = database.close.bind(database)
  database.close = () => {
    if (byFolder.get(key) === database) byFolder.delete(key)
    return close()
  }
  return database
}

/** Close `dataDir`'s test database if one is open: before its folder is deleted, so no write still landing puts a file back mid-delete. */
export async function closeTestDatabaseAt(dataDir: string): Promise<void> {
  await byFolder.get(resolve(dataDir))?.close()
}

/** Keep extension approvals for `dataDir` in its test database, as a Studio server holding it does. */
export function keepTestApprovalsIn(dataDir: string): void {
  const stop = keepExtensionApprovalsIn(dataDir, testDatabaseAt(dataDir))
  try {
    onTestFinished(stop)
  } catch {
    afterAll(stop)
  }
}

/** Put rows in a record table of `dataDir`'s database before anything opens it (what a store saved in an earlier run). */
export function seedRecordRows(
  dataDir: string,
  table: RecordTableName,
  rows: Array<{ id: string; body: unknown }>,
): void {
  const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    for (const [position, row] of rows.entries())
      connection.run(`INSERT OR REPLACE INTO ${table} (id, position, body) VALUES (?, ?, ?)`, [
        row.id,
        position,
        JSON.stringify(row.body),
      ])
  } finally {
    connection.close()
  }
}

/**
 * A record table's rows once what stores asked to save so far has landed:
 * a statement on the one writer answers only after the saves ahead of it.
 */
export async function savedRecordRows(
  dataDir: string,
  table: RecordTableName,
): Promise<Array<{ id: string; body: string }>> {
  const database = testDatabaseAt(dataDir)
  await new Promise((resolve) => setImmediate(resolve))
  await database.run('SELECT 1')
  return database.all<{ id: string; body: string }>(`SELECT id, body FROM ${table} ORDER BY position`)
}

/**
 * The database a test's chats are kept in: the one beside the store home the
 * test setup points every chat's store at, so a runtime made again in the
 * same test file (a restart) reads the history the one before it wrote.
 */
export function testChatDatabase(): StudioDatabase {
  const home = resolve(process.env.SPRINTENGINE_STORE_HOME?.trim() || tmpdir())
  const open = byFolder.get(home)
  if (open) return open
  // Kept for the whole file, as the store home is: a runtime one test makes may serve the next.
  const database = openStudioDatabase(home, { readers: 1 })
  outsideTests.push(database)
  byFolder.set(home, database)
  return database
}

/** Put a registry in `dataDir`'s database (a head row and a row per record), as a store saved it in an earlier run. */
export function seedRegistry(dataDir: string, registry: { workspaces?: unknown } & Record<string, unknown>): void {
  const { workspaces, ...head } = registry
  const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    connection.transaction(() => {
      connection.run('DELETE FROM chats')
      connection.run('INSERT OR REPLACE INTO chat_registry (id, body) VALUES (1, ?)', [JSON.stringify(head)])
      for (const [position, record] of (Array.isArray(workspaces) ? workspaces : []).entries())
        connection.run('INSERT INTO chats (id, position, body) VALUES (?, ?, ?)', [
          String((record as { id?: unknown }).id),
          position,
          JSON.stringify(record),
        ])
    })
  } finally {
    connection.close()
  }
}

/** The registry `dataDir`'s database holds, as the file kept it (`{ ...head, workspaces }`); null when none was written. */
export function savedRegistry(dataDir: string): ({ workspaces: unknown[] } & Record<string, unknown>) | null {
  const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    const head = connection.get<{ body: string }>('SELECT body FROM chat_registry WHERE id = 1')
    if (!head) return null
    const rows = connection.all<{ body: string }>('SELECT body FROM chats ORDER BY position')
    return {
      ...(JSON.parse(head.body) as Record<string, unknown>),
      workspaces: rows.map((row) => JSON.parse(row.body)),
    }
  } finally {
    connection.close()
  }
}

/** Put a whole-store record (`store_records`) in `dataDir`'s database, as its store saved it in an earlier run. */
export function seedStoreRecord(dataDir: string, name: string, body: string): void {
  const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    connection.run('INSERT OR REPLACE INTO store_records (name, body) VALUES (?, ?)', [name, body])
  } finally {
    connection.close()
  }
}

/** A whole-store record as `dataDir`'s database holds it; null when none was written. */
export function savedStoreRecord(dataDir: string, name: string): string | null {
  const connection = prepareStudioDatabase(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    return connection.get<{ body: string }>('SELECT body FROM store_records WHERE name = ?', [name])?.body ?? null
  } finally {
    connection.close()
  }
}

// The schedules' record for a test that names a place for them the way the
// store's file was named (`<dir>/scheduled-agents.json`): kept in `<dir>`'s
// database, read and seeded there.

/** The schedules kept in the database of the folder `file` is in. */
export function schedulesAt(file: string): SnapshotStorage {
  return snapshotStorageAt(dirname(file), 'schedules')
}

/** A whole-store record's storage in `dataDir`'s test database. */
export function snapshotStorageAt(dataDir: string, name: SnapshotStoreName): SnapshotStorage {
  return createSnapshotStorage(testDatabaseAt(dataDir), name)
}

/** The schedules as their store last saved them beside `file`; throws when none were saved. */
export function savedSchedules(file: string): string {
  const body = savedStoreRecord(dirname(file), 'schedules')
  if (body === null) throw new Error('No schedules were saved.')
  return body
}

/** Put schedules beside `file` as an earlier run saved them. */
export function seedSchedules(file: string, body: string): void {
  seedStoreRecord(dirname(file), 'schedules', body)
}
