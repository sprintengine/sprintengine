import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { copyStudioDatabase, databaseCopyName, DATABASE_COPIES_DIRNAME } from './copies'
import { STUDIO_DATABASE_FILENAME } from './database'
import { SyncConnection } from './sqlite'

// Runs on Windows in CI too: the copy is flushed to the disk before it is
// named, and a flush through a read-only handle there stopped the server at
// start with EPERM.

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'database-copies-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

test('the copy taken before a format step holds the database and is flushed under its name', () => {
  const live = new SyncConnection(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    live.run('CREATE TABLE notes (body TEXT)')
    live.run('INSERT INTO notes (body) VALUES (?)', ['kept'])
  } finally {
    live.close()
  }

  const relative = databaseCopyName(5)
  copyStudioDatabase(dataDir, relative)

  expect(readdirSync(join(dataDir, DATABASE_COPIES_DIRNAME))).toEqual(['studio-before-format-5.sqlite'])
  const copy = new SyncConnection(join(dataDir, relative))
  try {
    expect(copy.all('SELECT body FROM notes')).toEqual([{ body: 'kept' }])
  } finally {
    copy.close()
  }
  expect(existsSync(`${join(dataDir, relative)}.partial`)).toBe(false)
})
