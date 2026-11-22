import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')

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
  assert.deepEqual(await readExtensionFile(scope, 'docs/notes.md'), { content: 'hello', size: 5, sha256: sha('hello') })
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
  assert.deepEqual(await writeExtensionFile(scope, 'docs/notes.md', 'bye'), {
    size: 3,
    created: false,
    sha256: sha('bye'),
  })
  assert.equal(readFileSync(join(root, 'docs', 'notes.md'), 'utf8'), 'bye')
  assert.deepEqual(await writeExtensionFile(scope, 'docs/new.md', 'new', { create: true }), {
    size: 3,
    created: true,
    sha256: sha('new'),
  })
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/new.md', 'again', { create: true })), 'action_failed')
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/escape.txt', 'pwned')), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/escape.txt', 'pwned', { create: true })), 'action_failed')
  assert.equal(
    await refusal(writeExtensionFile(scope, 'linked-out/new.txt', 'pwned', { create: true })),
    'not_permitted',
  )
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret', 'nothing outside was touched')
})

test('a file with a second name is refused, for reading and for writing', async () => {
  const { scope, root, outside } = world()
  linkSync(join(outside, 'secret.txt'), join(root, 'docs', 'alias.txt'))
  assert.equal(await refusal(readExtensionFile(scope, 'docs/alias.txt')), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, 'docs/alias.txt', 'pwned')), 'not_permitted')
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('nothing is written or made under a .git folder', async () => {
  const { scope, root } = world()
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  symlinkSync(join(root, '.git'), join(root, 'innocent'))
  assert.equal(await refusal(writeExtensionFile(scope, '.git/config', '[core]\nfsmonitor = evil\n')), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, '.GIT/hooks-new', 'x', { create: true })), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, 'innocent/config', 'x')), 'not_permitted')
  assert.equal(await refusal(writeExtensionFile(scope, '.git', 'x', { create: true })), 'not_permitted')
  assert.equal(readFileSync(join(root, '.git', 'config'), 'utf8'), '[core]\n')
  assert.equal((await readExtensionFile(scope, '.git/config')).content, '[core]\n')
})

// Another process swapping a folder above the file for a link out, after the
// check and before the open: the open follows it, and is refused.
function swapDocsOut(root: string, outside: string) {
  return async () => {
    renameSync(join(root, 'docs'), join(root, 'docs-moved'))
    mkdirSync(join(outside, 'docs'))
    writeFileSync(join(outside, 'docs', 'notes.md'), 'outside')
    symlinkSync(join(outside, 'docs'), join(root, 'docs'))
  }
}

test('a folder above the file swapped for a link out between the check and the open is refused', async () => {
  const read = world()
  assert.equal(
    await refusal(
      readExtensionFile({ ...read.scope, betweenCheckAndOpen: swapDocsOut(read.root, read.outside) }, 'docs/notes.md'),
    ),
    'not_permitted',
  )
  const write = world()
  assert.equal(
    await refusal(
      writeExtensionFile(
        { ...write.scope, betweenCheckAndOpen: swapDocsOut(write.root, write.outside) },
        'docs/notes.md',
        'x',
      ),
    ),
    'not_permitted',
  )
  assert.equal(readFileSync(join(write.outside, 'docs', 'notes.md'), 'utf8'), 'outside', 'nothing outside was written')
  const create = world()
  assert.equal(
    await refusal(
      writeExtensionFile(
        { ...create.scope, betweenCheckAndOpen: swapDocsOut(create.root, create.outside) },
        'docs/new.md',
        'x',
        { create: true },
      ),
    ),
    'not_permitted',
  )
  assert.equal(existsSync(join(create.outside, 'docs', 'new.md')), false, 'the empty file made outside is taken away')
})

test('a search does not read a folder that is now a link out', async () => {
  const { scope, root, outside } = world()
  await swapDocsOut(root, outside)()
  assert.deepEqual((await searchExtensionFiles(scope, 'notes', undefined)).paths, ['docs-moved/notes.md'])
  assert.ok(existsSync(join(outside, 'docs', 'notes.md')))
})

test('bytes travel as base64, both ways', async () => {
  const { scope, root } = world()
  const bytes = Buffer.from([0, 255, 16, 128])
  writeFileSync(join(root, 'docs', 'blob.bin'), bytes)
  const read = await readExtensionFile(scope, 'docs/blob.bin', 'base64')
  assert.deepEqual(read, { content: bytes.toString('base64'), size: 4, sha256: sha(bytes) })
  const next = Buffer.from([1, 2, 3])
  await writeExtensionFile(scope, 'docs/blob.bin', next.toString('base64'), { encoding: 'base64' })
  assert.deepEqual(readFileSync(join(root, 'docs', 'blob.bin')), next)
  assert.equal(await refusal(readExtensionFile(scope, 'docs/blob.bin', 'hex')), 'invalid_params')
  assert.equal(
    await refusal(writeExtensionFile(scope, 'docs/blob.bin', 'not base64!', { encoding: 'base64' })),
    'invalid_params',
  )
})

test('a write against the bytes it read is refused once the file changed or went, and nothing is written', async () => {
  const { scope, root } = world()
  const read = await readExtensionFile(scope, 'docs/notes.md')
  writeFileSync(join(root, 'docs', 'notes.md'), 'changed by someone else')
  assert.equal(
    await refusal(writeExtensionFile(scope, 'docs/notes.md', 'mine', { expectedSha256: read.sha256 })),
    'conflict',
  )
  assert.equal(readFileSync(join(root, 'docs', 'notes.md'), 'utf8'), 'changed by someone else')
  const again = await readExtensionFile(scope, 'docs/notes.md')
  assert.equal(
    (await writeExtensionFile(scope, 'docs/notes.md', 'mine', { expectedSha256: again.sha256 })).sha256,
    sha('mine'),
  )
  rmSync(join(root, 'docs', 'notes.md'))
  assert.equal(
    await refusal(writeExtensionFile(scope, 'docs/notes.md', 'mine', { expectedSha256: again.sha256 })),
    'conflict',
  )
  assert.equal(existsSync(join(root, 'docs', 'notes.md')), false)
})

test('two saves against the same bytes: one is written whole, the other is refused, never a mix', async () => {
  const { scope, root } = world()
  const read = await readExtensionFile(scope, 'docs/notes.md')
  // Both checks pass before either writes, as two windows saving at once would.
  const paused = { ...scope, beforeCommit: () => new Promise<void>((resolve) => setTimeout(resolve, 30)) }
  const outcomes = await Promise.all(
    ['AAAAAAAA', 'BB'].map((content) =>
      writeExtensionFile(paused, 'docs/notes.md', content, { expectedSha256: read.sha256 }).then(
        () => 'written',
        (error: ExtensionFileRefusal) => error.code,
      ),
    ),
  )
  assert.deepEqual([...outcomes].sort(), ['conflict', 'written'])
  const now = readFileSync(join(root, 'docs', 'notes.md'), 'utf8')
  assert.ok(now === 'AAAAAAAA' || now === 'BB', `the file holds one save whole, not "${now}"`)
})

test('a file or folder that is not there is refused as missing, by its code', async () => {
  const { scope } = world()
  assert.equal(await refusal(readExtensionFile(scope, 'docs/gone.md')), 'missing')
  assert.equal(await refusal(statExtensionFile(scope, 'gone')), 'missing')
  assert.equal(await refusal(writeExtensionFile(scope, 'gone/new.md', 'x')), 'missing')
})
