import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  ExtensionFileRefusal,
  readExtensionFile,
  searchExtensionFiles,
  statExtensionFile,
  writeExtensionFile,
} from './extension-files'

// A frame reaches files only inside a workspace's folder, by real path, and
// never through a link out of it, whichever way it asks.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function world() {
  const base = mkdtempSync(join(tmpdir(), 'extension-files-'))
  dirs.push(base)
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  const studio = join(root, '.studio-data')
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(outside)
  mkdirSync(studio)
  writeFileSync(join(root, 'docs', 'notes.md'), 'hello')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  writeFileSync(join(studio, 'kept.json'), '{}')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'docs', 'escape.txt'))
  symlinkSync(outside, join(root, 'linked-out'))
  return { scope: { root, forbidden: [studio] }, root, outside }
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof ExtensionFileRefusal, String(error))
    return error.code
  }
  return 'answered'
}

test('a file inside the workspace is read, stat’d and found', async () => {
  const { scope } = world()
  assert.deepEqual(await readExtensionFile(scope, 'docs/notes.md'), { content: 'hello', size: 5 })
  assert.equal((await statExtensionFile(scope, 'docs')).type, 'directory')
  const found = await searchExtensionFiles(scope, 'NOTES', undefined)
  assert.deepEqual(found, { paths: ['docs/notes.md'], truncated: false })
})

test('a path out of the folder, absolute or through a link, is refused', async () => {
  const { scope } = world()
  assert.equal(await refusal(readExtensionFile(scope, '../outside/secret.txt')), 'invalid_params')
  assert.equal(await refusal(readExtensionFile(scope, '/etc/hosts')), 'invalid_params')
  assert.equal(await refusal(readExtensionFile(scope, 'docs/escape.txt')), 'not_permitted')
  assert.equal(await refusal(readExtensionFile(scope, 'linked-out/secret.txt')), 'not_permitted')
  assert.equal(await refusal(statExtensionFile(scope, 'linked-out')), 'not_permitted')
  assert.equal(await refusal(readExtensionFile(scope, '.studio-data/kept.json')), 'not_permitted')
})

test('a search lists a link by its name and never walks through it', async () => {
  const { scope } = world()
  assert.deepEqual((await searchExtensionFiles(scope, 'secret', undefined)).paths, [])
  assert.deepEqual((await searchExtensionFiles(scope, 'linked', undefined)).paths, ['linked-out'])
  assert.deepEqual((await searchExtensionFiles(scope, 'kept', undefined)).paths, [], 'Studio’s own folder is skipped')
})

test('a write replaces a file in place, a create refuses one that exists, and neither goes through a link', async () => {
  const { scope, root, outside } = world()
  assert.deepEqual(await writeExtensionFile(scope, 'docs/notes.md', 'bye', false), { size: 3, created: false })
  assert.equal(readFileSync(join(root, 'docs', 'notes.md'), 'utf8'), 'bye')
  assert.deepEqual(await writeExtensionFile(scope, 'docs/new.md', 'new', true), { size: 3, created: true })
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/new.md', 'again', true)), 'action_failed')
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/escape.txt', 'pwned', false)), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/escape.txt', 'pwned', true)), 'action_failed')
  assert.equal(await refusal(writeExtensionFile(scope, 'linked-out/new.txt', 'pwned', true)), 'not_permitted')
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret', 'nothing outside was touched')
})
