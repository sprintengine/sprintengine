import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.deepEqual(prepareDataFormat(dir, { version: '1.0.0' }), { format: 1, migrated: [], restored: false })
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
  // Marked once: a later start by another version leaves the marker as it is.
  prepareDataFormat(dir, { version: '1.0.1' })
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
})

test('data newer than this server reads is refused, naming who wrote it', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: JSON.stringify({ format: 2, writtenBy: '2.0.0' }) })
  assert.throws(
    () => prepareDataFormat(dir, { version: '1.0.0' }),
    (error: unknown) =>
      error instanceof StudioDataTooNewError &&
      /written by Studio 2\.0\.0 .*this Studio server \(1\.0\.0\) .*Update this server\./u.test(error.message),
  )
  assert.deepEqual(format(dir), { format: 2, writtenBy: '2.0.0' }, 'never rewritten')
})

test('a marker that does not read is refused rather than read as format 1', () => {
  const dir = dataDir({ [DATA_FORMAT_FILENAME]: 'not json' })
  assert.throws(() => prepareDataFormat(dir, { version: '1.0.0' }), StudioDataMigrationError)
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
  const prepared = prepareDataFormat(dir, { version: '1.0.0' })
  assert.deepEqual(prepared, { format: 1, migrated: [], restored: true })
  assert.equal(text(dir, 'stores/chats.json'), '{"v":1}')
  assert.deepEqual(format(dir), { format: 1, writtenBy: '1.0.0' })
  assert.ok(!existsSync(backup))
})

test('copies with no marker belong to a step that never started, and are dropped', () => {
  const dir = dataDir({ 'stores/chats.json': '{"v":1}', 'migration-backup/files/stores/chats.json': 'stale' })
  assert.equal(prepareDataFormat(dir, { version: '1.0.0' }).restored, false)
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
