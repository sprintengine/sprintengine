// A data folder's database for a test: opened in a scratch folder of its own
// (or the one given), with one reader, and closed when the test that opened
// it ends, or with the file when it was opened outside a test.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, onTestFinished } from 'vitest'

import { keepExtensionApprovalsIn } from '../src/main/modules/extension-approvals'
import {
  openStudioDatabase,
  prepareStudioDatabase,
  STUDIO_DATABASE_FILENAME,
  type StudioDatabase,
} from '../src/server/db/database'
import type { RecordTableName } from '../src/server/db/record-table'

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
  return testDatabaseAt(process.env.SPRINTENGINE_STORE_HOME?.trim() || tmpdir())
}
