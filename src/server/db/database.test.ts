import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { openStudioDatabase, prepareStudioDatabase, STUDIO_DATABASE_FILENAME } from './database'
import {
  StudioDatabaseDamagedError,
  StudioDatabaseError,
  StudioDatabaseFolderError,
  StudioDatabaseMigrationError,
  StudioDatabaseTooNewError,
} from './errors'
import { STUDIO_MIGRATIONS, type Migration } from './migrations'
import { SyncConnection } from './sqlite'

const folder = () => mkdtempSync(join(tmpdir(), 'se-db-'))
const pathIn = (dir: string) => join(dir, STUDIO_DATABASE_FILENAME)

const recorded = (dir: string) => {
  const connection = new SyncConnection(pathIn(dir))
  try {
    return connection
      .all<{ id: number; name: string }>('SELECT id, name FROM schema_migrations ORDER BY id')
      .map((row) => ({ ...row }))
  } finally {
    connection.close()
  }
}

test('a first open makes the file in WAL mode, migrated, and only the owner may read it', async () => {
  const dir = folder()
  const db = openStudioDatabase(dir)
  try {
    assert.equal((await db.get<{ journal_mode: string }>('PRAGMA journal_mode'))?.journal_mode, 'wal')
    assert.equal((await db.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum'))?.auto_vacuum, 2)
    if (process.platform !== 'win32') assert.equal(statSync(pathIn(dir)).mode & 0o777, 0o600)
  } finally {
    await db.close()
  }
  assert.deepEqual(
    recorded(dir).map((row) => row.id),
    STUDIO_MIGRATIONS.map((migration) => migration.id),
  )
  // Closed: the WAL was checkpointed into the file and removed.
  assert.equal(existsSync(`${pathIn(dir)}-wal`), false)
  // Opened again, nothing runs twice.
  const again = openStudioDatabase(dir)
  await again.close()
  assert.equal(recorded(dir).length, STUDIO_MIGRATIONS.length)
})

test('writes commit in order, a batch and a transaction land whole or not at all, and reads see what committed', async () => {
  const migrations: Migration[] = [
    { id: 1, name: 'items', up: (c) => c.exec('CREATE TABLE items (id TEXT PRIMARY KEY, n INTEGER NOT NULL)') },
  ]
  const db = openStudioDatabase(folder(), { migrations })
  try {
    await Promise.all([
      db.run('INSERT INTO items VALUES (?, ?)', ['a', 1]),
      db.run('INSERT INTO items VALUES (?, ?)', ['b', 2]),
    ])
    assert.deepEqual(
      (await db.all<{ id: string }>('SELECT id FROM items ORDER BY rowid')).map((row) => row.id),
      ['a', 'b'],
    )
    // The second statement breaks the key: the first does not land either.
    await assert.rejects(
      db.batch([
        { sql: 'INSERT INTO items VALUES (?, ?)', params: ['c', 3] },
        { sql: 'INSERT INTO items VALUES (?, ?)', params: ['a', 4] },
      ]),
      /UNIQUE/u,
    )
    assert.equal(await db.get('SELECT id FROM items WHERE id = ?', ['c']), undefined)
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run('UPDATE items SET n = n + 10')
        assert.equal((await tx.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['a']))?.n, 11)
        throw new Error('changed my mind')
      }),
      /changed my mind/u,
    )
    assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['a']))?.n, 1)

    // A read while a transaction is open sees the data before it, and is not held up by it.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const writing = db.transaction(async (tx) => {
      await tx.run('UPDATE items SET n = 100 WHERE id = ?', ['a'])
      entered()
      await held
    })
    await inside
    assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['a']))?.n, 1)
    // A write asked meanwhile waits its turn behind the transaction.
    const after = db.run('UPDATE items SET n = n + 1 WHERE id = ?', ['a'])
    release()
    await writing
    await after
    assert.equal((await db.get<{ n: number }>('SELECT n FROM items WHERE id = ?', ['a']))?.n, 101)
    // A reader refuses a write rather than taking the writer's place.
    await assert.rejects(db.all("INSERT INTO items VALUES ('z', 0) RETURNING id"), /readonly/iu)
  } finally {
    await db.close()
  }
  await assert.rejects(db.get('SELECT 1'), StudioDatabaseError)
  await assert.rejects(db.run('SELECT 1'), StudioDatabaseError)
})

test('a damaged file, or one that is not a database, stops the open in words and is never read as empty', () => {
  const dir = folder()
  writeFileSync(pathIn(dir), 'these are not the records you are looking for\n'.repeat(200))
  assert.throws(() => openStudioDatabase(dir), (error: unknown) => {
    assert.ok(error instanceof StudioDatabaseDamagedError)
    assert.match(error.message, /damaged or is not a SQLite database/u)
    assert.match(error.message, /-wal and -shm/u)
    return true
  })
  // Left as it was: nothing wrote over it.
  assert.equal(statSync(pathIn(dir)).size, 9200)
})

test('a folder where the database cannot use WAL is refused, saying to pick a local one', () => {
  const dir = folder()
  // SQLite cannot make its WAL file where a folder stands in its place.
  mkdirSync(`${pathIn(dir)}-wal`)
  assert.throws(() => openStudioDatabase(dir), (error: unknown) => {
    assert.ok(error instanceof StudioDatabaseFolderError)
    assert.match(error.message, /write-ahead logging/u)
    assert.match(error.message, /local disk/u)
    return true
  })
})

test('a database a newer Studio migrated is refused rather than written on', () => {
  const dir = folder()
  const newer: Migration[] = [...STUDIO_MIGRATIONS, { id: 999, name: 'from-the-future', up: () => undefined }]
  prepareStudioDatabase(pathIn(dir), newer).close()
  assert.throws(() => openStudioDatabase(dir), StudioDatabaseTooNewError)
  // And one that numbered a migration differently.
  const other = folder()
  prepareStudioDatabase(pathIn(other), [{ id: 1, name: 'something-else', up: () => undefined }]).close()
  assert.throws(() => openStudioDatabase(other), /calls "chat-side-records"/u)
})

test('a migration that fails is rolled back alone, and the next start carries on from it', async () => {
  const dir = folder()
  let fail = true
  const migrations: Migration[] = [
    { id: 1, name: 'one', up: (c) => c.exec('CREATE TABLE one (id INTEGER)') },
    {
      id: 2,
      name: 'two',
      up: (c) => {
        c.exec('CREATE TABLE two (id INTEGER)')
        if (fail) throw new Error('the power went')
      },
    },
  ]
  assert.throws(() => openStudioDatabase(dir, { migrations }), (error: unknown) => {
    assert.ok(error instanceof StudioDatabaseMigrationError)
    assert.match(error.message, /\(migration 2 "two" failed and was rolled back\): the power went/u)
    return true
  })
  assert.deepEqual(recorded(dir), [{ id: 1, name: 'one' }])
  fail = false
  const db = openStudioDatabase(dir, { migrations })
  try {
    assert.deepEqual(
      (await db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('one', 'two') ORDER BY name")).map(
        (row) => row.name,
      ),
      ['one', 'two'],
    )
  } finally {
    await db.close()
  }
})
