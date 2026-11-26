// A data folder's database for a test: opened in a scratch folder of its own
// (or the one given), with one reader, and closed when the test that opened
// it ends, or with the file when it was opened outside a test.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, onTestFinished } from 'vitest'

import { openStudioDatabase, type StudioDatabase } from '../src/server/db/database'

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
