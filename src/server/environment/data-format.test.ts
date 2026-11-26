import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  DATA_FORMAT_FILENAME,
  MIGRATION_BACKUP_DIRNAME,
  prepareDataFormat,
  StudioDataMigrationError,
  StudioDataTooNewError,
  type DataFormatStep,
} from './data-format'
import { DATABASE_COPIES_DIRNAME } from '../db/copies'
import { prepareStudioDatabase, STUDIO_DATABASE_FILENAME } from '../db/database'
import type { Migration } from '../db/migrations'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-format-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

/** A build that reads format 1 and knows no step: the data-format rules on their own. */
const FORMAT_1 = { version: '1.0.0', format: 1, steps: [] }

const format = (dir: string) => JSON.parse(readFileSync(join(dir, DATA_FORMAT_FILENAME), 'utf8')) as unknown
const text = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8')

/** Format 2 renames a store's field; format 3 adds a file. */
const steps = (fail: number | null = null): DataFormatStep[] => [
  {
    to: 2,
    files: ['stores/chats.json'],
    run: (dir) => {
      writeFileSync(join(dir, 'stores/chats.json'), '{"v":2}')
      if (fail === 2) throw new Error('disk full')
    },
  },
  {
    to: 3,
    files: ['stores/new.json'],
    run: (dir) => {
      writeFileSync(join(dir, 'stores/new.json'), '{}')
      if (fail === 3) throw new Error('disk full')
    },
  },
]

test("a directory with no marker is today's format, and is marked so", () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":1}' })
  assert.deepEqual(prepareDataFormat(dir, FORMAT_1), { format: 1, migrated: [], restored: false })
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
  // Marked once: a later start by another version leaves the marker as it is.
  prepareDataFormat(dir, { ...FORMAT_1, version: '1.0.1' })
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
})

test('data newer than this server reads is refused, naming who wrote it', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: JSON.stringify({ format: 2, writtenBy: '2.0.0' }) })
  assert.throws(
    () => prepareDataFormat(dir, FORMAT_1),
    (error: unknown) =>
      error instanceof StudioDataTooNewError &&
      /written by Studio 2\.0\.0 .*this Studio server \(1\.0\.0\) .*Update this server\./u.test(error.message),
  )
  assert.deepEqual(format(dir), { format: 2, writtenBy: '2.0.0' }, 'never rewritten')
})

test('a marker that does not read is refused rather than read as format 1', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: 'not json' })
  assert.throws(() => prepareDataFormat(dir, FORMAT_1), StudioDataMigrationError)
})

test('steps run in order, each marking the format it reached, and leave no backup', () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":1}' })
  assert.deepEqual(prepareDataFormat(dir, { version: '3.0.0', format: 3, steps: steps() }), {
    format: 3,
    migrated: [2, 3],
    restored: false,
  })
  assert.deepEqual(format(dir), { format: 3, writtenBy: '3.0.0' })
  assert.equal(text(dir, 'stores/chats.json'), '{"v":2}')
  assert.ok(!existsSync(join(dir, MIGRATION_BACKUP_DIRNAME)))
})

test('a step that throws is undone from its copies, and the server refuses to start', () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":2}', [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  assert.throws(
    () => prepareDataFormat(dir, { version: '3.0.0', format: 3, steps: steps(3) }),
    (error: unknown) => error instanceof StudioDataMigrationError && /from format 2 to 3 failed/u.test(error.message),
  )
  // The file the step made is gone; the marker is the one it found.
  assert.ok(!existsSync(join(dir, 'stores/new.json')))
  assert.equal(text(dir, DATA_FORMAT_FILENAME), '{"format":2,"writtenBy":"2.0.0"}')
  assert.ok(!existsSync(join(dir, MIGRATION_BACKUP_DIRNAME)))
})

test('a start that finds an interrupted step restores its copies before anything reads the data', () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":1}' })
  // A step cut by a crash: copies and marker written, the store half changed.
  const backup = join(dir, MIGRATION_BACKUP_DIRNAME)
  mkdirSync(join(backup, 'files', 'stores'), { recursive: true })
  writeFileSync(join(backup, 'files', 'stores/chats.json'), '{"v":1}')
  writeFileSync(
    join(backup, 'marker.json'),
    JSON.stringify({
      from: 1,
      to: 2,
      files: [
        { path: DATA_FORMAT_FILENAME, existed: false },
        { path: 'stores/chats.json', existed: true },
      ],
    }),
  )
  writeFileSync(join(dir, 'stores/chats.json'), '{"v":2, half')
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), '{"format":2,"writtenBy":"2.0.0"}')
  const prepared = prepareDataFormat(dir, FORMAT_1)
  assert.deepEqual(prepared, { format: 1, migrated: [], restored: true })
  assert.equal(text(dir, 'stores/chats.json'), '{"v":1}')
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
  assert.ok(!existsSync(backup))
})

test('copies with no marker belong to a step that never started, and are dropped', () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":1}', 'migration-backup/files/stores/chats.json': 'stale' })
  assert.equal(prepareDataFormat(dir, FORMAT_1).restored, false)
  assert.equal(text(dir, 'stores/chats.json'), '{"v":1}')
  assert.ok(!existsSync(join(dir, MIGRATION_BACKUP_DIRNAME)))
})

test('a step naming a file outside the data directory is refused before it runs', () => {
  const dir = dataDir()
  let ran = false
  assert.throws(
    () =>
      prepareDataFormat(dir, {
        version: '2.0.0',
        format: 2,
        steps: [{ to: 2, files: ['../elsewhere'], run: () => (ran = true) }],
      }),
    StudioDataMigrationError,
  )
  assert.equal(ran, false)
})

// Steps that change the database: a table of notes, changed by format 3 and 4.
const NOTES: Migration[] = [{ id: 1, name: 'notes', up: (c) => c.exec('CREATE TABLE notes (body TEXT NOT NULL)') }]
const databaseIn = (dir: string) => join(dir, STUDIO_DATABASE_FILENAME)
const notes = (path: string): string[] => {
  const connection = prepareStudioDatabase(path, NOTES)
  try {
    return connection.all<{ body: string }>('SELECT body FROM notes ORDER BY rowid').map((row) => row.body)
  } finally {
    connection.close()
  }
}
const addNote = (dir: string, body: string) => {
  const connection = prepareStudioDatabase(databaseIn(dir), NOTES)
  try {
    connection.run('INSERT INTO notes (body) VALUES (?)', [body])
  } finally {
    connection.close()
  }
}
const noteStep = (to: number, body: string, after?: (dir: string) => void): DataFormatStep => ({
  to,
  files: [],
  database: true,
  run: (dir) => {
    addNote(dir, body)
    after?.(dir)
  },
})
const copies = (dir: string) => readdirSync(join(dir, DATABASE_COPIES_DIRNAME)).sort()

test('a step that changes the database copies it first, and keeps only the latest copy', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  addNote(dir, 'from format 2')
  prepareDataFormat(dir, { version: '3.0.0', format: 3, steps: [noteStep(3, 'by step 3')] })
  assert.deepEqual(copies(dir), ['studio-before-format-3.sqlite'])
  assert.deepEqual(notes(join(dir, DATABASE_COPIES_DIRNAME, 'studio-before-format-3.sqlite')), ['from format 2'])
  assert.deepEqual(notes(databaseIn(dir)), ['from format 2', 'by step 3'])

  // The next step's copy replaces it: after the first step the files are no
  // longer the way back, so this copy is, and one is enough.
  prepareDataFormat(dir, { version: '4.0.0', format: 4, steps: [noteStep(3, 'by step 3'), noteStep(4, 'by step 4')] })
  assert.deepEqual(copies(dir), ['studio-before-format-4.sqlite'])
  assert.deepEqual(notes(join(dir, DATABASE_COPIES_DIRNAME, 'studio-before-format-4.sqlite')), [
    'from format 2',
    'by step 3',
  ])
  assert.ok(!existsSync(join(dir, MIGRATION_BACKUP_DIRNAME)))
})

test('a database step that fails puts the database back from its copy, and the copy before stays the kept one', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  addNote(dir, 'from format 2')
  prepareDataFormat(dir, { version: '3.0.0', format: 3, steps: [noteStep(3, 'by step 3')] })
  assert.throws(
    () =>
      prepareDataFormat(dir, {
        version: '4.0.0',
        format: 4,
        steps: [
          noteStep(3, 'by step 3'),
          noteStep(4, 'by step 4', () => {
            throw new Error('disk full')
          }),
        ],
      }),
    /from format 3 to 4 failed, so it was put back as it was: disk full/u,
  )
  assert.deepEqual(notes(databaseIn(dir)), ['from format 2', 'by step 3'])
  assert.ok(!existsSync(`${databaseIn(dir)}-wal`))
  assert.deepEqual(copies(dir), ['studio-before-format-3.sqlite'])
  assert.deepEqual(format(dir), { format: 3, writtenBy: '3.0.0' })
})

test('a database step a crash cut short is undone from its copy at the next start', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  addNote(dir, 'from format 2')
  const crashed = join(dataDir(), 'crashed')
  // The folder as a crash would leave it: copy and marker written, the step's
  // change in the database, the format not yet moved.
  prepareDataFormat(dir, {
    version: '3.0.0',
    format: 3,
    steps: [noteStep(3, 'by step 3', (at) => cpSync(at, crashed, { recursive: true }))],
  })
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2', 'by step 3'])
  assert.deepEqual(prepareDataFormat(crashed, { version: '2.0.0', format: 2, steps: [] }), {
    format: 2,
    migrated: [],
    restored: true,
  })
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2'])
  assert.ok(!existsSync(join(crashed, MIGRATION_BACKUP_DIRNAME)))
})

test('the step that makes the database has nothing to copy, and a failure leaves no database behind', () => {
  const dir = dataDir()
  assert.throws(
    () =>
      prepareDataFormat(dir, {
        version: '2.0.0',
        format: 2,
        steps: [
          noteStep(2, 'first', () => {
            throw new Error('no')
          }),
        ],
      }),
    StudioDataMigrationError,
  )
  assert.ok(!existsSync(databaseIn(dir)))
  assert.ok(!existsSync(join(dir, DATABASE_COPIES_DIRNAME)))
  prepareDataFormat(dir, { version: '2.0.0', format: 2, steps: [noteStep(2, 'first')] })
  assert.deepEqual(notes(databaseIn(dir)), ['first'])
  assert.ok(!existsSync(join(dir, DATABASE_COPIES_DIRNAME)))
})

test('a database that cannot be copied stops the step before it changes anything', () => {
  const dir = dataDir({
    [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}',
    [STUDIO_DATABASE_FILENAME]: 'not a database, '.repeat(400),
  })
  let ran = false
  assert.throws(
    () =>
      prepareDataFormat(dir, {
        version: '3.0.0',
        format: 3,
        steps: [{ to: 3, files: [], database: true, run: () => (ran = true) }],
      }),
    /could not copy its database .* nothing was changed/u,
  )
  assert.equal(ran, false)
  assert.deepEqual(format(dir), { format: 2, writtenBy: '2.0.0' })
  assert.ok(!existsSync(join(dir, MIGRATION_BACKUP_DIRNAME)))
})

/** A folder as a crash in the middle of a database step leaves it: copy and marker written, the step's change made. */
function crashedInStep(): string {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  addNote(dir, 'from format 2')
  const crashed = join(dataDir(), 'crashed')
  prepareDataFormat(dir, {
    version: '3.0.0',
    format: 3,
    steps: [noteStep(3, 'by step 3', (at) => cpSync(at, crashed, { recursive: true }))],
  })
  return crashed
}

test('a restore a crash cut short runs again from the same copies, and only then lets them go', () => {
  const crashed = crashedInStep()
  const copy = join(crashed, DATABASE_COPIES_DIRNAME, 'studio-before-format-3.sqlite')
  // The restore got as far as putting the database back, and stopped before its commit.
  cpSync(copy, databaseIn(crashed))
  rmSync(`${databaseIn(crashed)}-wal`, { force: true })
  assert.ok(existsSync(join(crashed, MIGRATION_BACKUP_DIRNAME, 'marker.json')))
  assert.ok(existsSync(copy), 'the copy is kept while the marker says the restore is not done')

  assert.equal(prepareDataFormat(crashed, { version: '2.0.0', format: 2, steps: [] }).restored, true)
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2'])
  assert.ok(!existsSync(join(crashed, MIGRATION_BACKUP_DIRNAME)))
  assert.ok(!existsSync(copy), 'the copy of a step that did not happen goes once the restore stands')
  // Again: nothing left to undo, and the data stays as it is.
  assert.equal(prepareDataFormat(crashed, { version: '2.0.0', format: 2, steps: [] }).restored, false)
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2'])
})

test('a restore whose copy is missing refuses and deletes nothing', () => {
  const crashed = crashedInStep()
  rmSync(join(crashed, DATABASE_COPIES_DIRNAME, 'studio-before-format-3.sqlite'))
  assert.throws(
    () => prepareDataFormat(crashed, { version: '2.0.0', format: 2, steps: [] }),
    /cannot be undone: .*studio-before-format-3\.sqlite is missing\. Nothing was changed/u,
  )
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2', 'by step 3'], 'the live database is left alone')
  assert.ok(existsSync(join(crashed, MIGRATION_BACKUP_DIRNAME, 'marker.json')))
})

test('a step that crashed after its commit point stands, and its leftover copies are dropped', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: '{"format":2,"writtenBy":"2.0.0"}' })
  addNote(dir, 'from format 2')
  const crashed = join(dataDir(), 'crashed')
  // Taken as the step ends: what a crash just after the marker went would leave.
  prepareDataFormat(dir, {
    version: '3.0.0',
    format: 3,
    steps: [
      noteStep(3, 'by step 3', (at) => {
        writeFileSync(join(at, DATA_FORMAT_FILENAME), '{"format":3,"writtenBy":"3.0.0"}')
        cpSync(at, crashed, { recursive: true })
        rmSync(join(crashed, MIGRATION_BACKUP_DIRNAME, 'marker.json'))
      }),
    ],
  })
  assert.equal(prepareDataFormat(crashed, { version: '3.0.0', format: 3, steps: [] }).restored, false)
  assert.deepEqual(notes(databaseIn(crashed)), ['from format 2', 'by step 3'])
  assert.deepEqual(format(crashed), { format: 3, writtenBy: '3.0.0' })
  assert.ok(!existsSync(join(crashed, MIGRATION_BACKUP_DIRNAME)))
})
