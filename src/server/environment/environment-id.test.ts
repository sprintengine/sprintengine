import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { STUDIO_ENVIRONMENT_FILENAME, readStudioEnvironmentId } from './environment-id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const KEPT = '0f8e2b1c-3a4d-4e5f-8a9b-1c2d3e4f5a6b'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o700)
    } catch {
      // Gone already.
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'studio-environment-id-'))
  directories.push(directory)
  return directory
}

const stored = (dir: string): unknown => JSON.parse(readFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), 'utf8')).id

test('a data directory mints its id once and keeps it', () => {
  const dir = dataDir()
  const id = readStudioEnvironmentId(dir)
  assert.match(id, UUID)
  assert.equal(stored(dir), id)
  assert.equal(readStudioEnvironmentId(dir), id)
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, STUDIO_ENVIRONMENT_FILENAME)).mode & 0o777, 0o600)
  // Nothing staged is left beside it.
  assert.deepEqual(readdirSync(dir), [STUDIO_ENVIRONMENT_FILENAME])
})

test('an id already on disk is the one read', () => {
  const dir = dataDir()
  writeFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), JSON.stringify({ id: KEPT }))
  assert.equal(readStudioEnvironmentId(dir), KEPT)
})

test('a file that holds no id is moved aside, not lost, and a new id is minted', () => {
  const dir = dataDir()
  writeFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), '{"id": "not-a-uuid"}')
  const logs: string[] = []
  const id = readStudioEnvironmentId(dir, { log: (message) => logs.push(message) })
  assert.match(id, UUID)
  assert.equal(stored(dir), id)
  const aside = readdirSync(dir).filter((name) => name.startsWith(`${STUDIO_ENVIRONMENT_FILENAME}.malformed-`))
  assert.equal(aside.length, 1)
  assert.equal(readFileSync(join(dir, aside[0]!), 'utf8'), '{"id": "not-a-uuid"}')
  assert.equal(logs.length, 1)
})

test('a file that is not JSON is moved aside the same way', () => {
  const dir = dataDir()
  writeFileSync(join(dir, STUDIO_ENVIRONMENT_FILENAME), '')
  const id = readStudioEnvironmentId(dir)
  assert.equal(stored(dir), id)
})

test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'a file that cannot be read is never written over: the run goes by a temporary id',
  () => {
    const dir = dataDir()
    const path = join(dir, STUDIO_ENVIRONMENT_FILENAME)
    writeFileSync(path, JSON.stringify({ id: KEPT }))
    chmodSync(path, 0o000)
    const logs: string[] = []
    const id = readStudioEnvironmentId(dir, { log: (message) => logs.push(message) })
    assert.match(id, UUID)
    assert.notEqual(id, KEPT)
    // Asked again in the same run, the same temporary id: every door says one.
    assert.equal(readStudioEnvironmentId(dir), id)
    chmodSync(path, 0o600)
    assert.equal(stored(dir), KEPT)
    assert.equal(logs.length, 1)
  },
)

test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'a directory it cannot write to still gives an id, and leaves nothing behind',
  () => {
    const dir = join(dataDir(), 'locked')
    mkdirSync(dir, { mode: 0o500 })
    directories.push(dir)
    const logs: string[] = []
    const id = readStudioEnvironmentId(dir, { log: (message) => logs.push(message) })
    assert.match(id, UUID)
    assert.equal(logs.length, 1)
    assert.deepEqual(readdirSync(dir), [])
  },
)
