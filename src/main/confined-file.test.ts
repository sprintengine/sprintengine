import assert from 'node:assert/strict'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, test } from 'vitest'

import {
  CONFINED_FILE_CHANGED,
  CONFINED_FILE_LINKED,
  CONFINED_READ_MAX_BYTES,
  copyConfinedDirectory,
  isConfinedFileTooLarge,
  readConfinedFile,
  realFolderPath,
  writeConfinedFile,
} from './confined-file'

// A write held to a folder is checked first and done after; whatever is put at
// the path in between must not lead the write, or a read, anywhere else.

const posix = process.platform !== 'win32'

describe.runIf(posix)('confined file reads and writes', () => {
  let root: string
  let folder: string
  let secret: string
  const secretText = 'PRIVATE_CANARY\n'

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'confined-file-')))
    folder = join(root, 'project')
    await mkdir(folder)
    await mkdir(join(root, 'private'))
    secret = join(root, 'private', 'secret.md')
    await writeFile(secret, secretText)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('write and read a plain file, creating it, replacing it, and refusing to clobber when exclusive', async () => {
    const path = join(folder, 'item.md')
    await writeConfinedFile(path, 'first, longer contents\n')
    await writeConfinedFile(path, 'second\n')
    assert.equal(await readConfinedFile(path, 'utf-8'), 'second\n')
    await assert.rejects(writeConfinedFile(path, 'third\n', { exclusive: true }), { code: 'EEXIST' })
    await writeConfinedFile(join(folder, 'tool.sh'), '#!/bin/sh\n', { exclusive: true, mode: 0o755 })
    assert.equal((await stat(join(folder, 'tool.sh'))).mode & 0o777, 0o755)
  })

  test('a link at the path is never written or read through', async () => {
    const path = join(folder, 'item.md')
    await symlink(secret, path)
    await assert.rejects(writeConfinedFile(path, 'planted\n'), { message: CONFINED_FILE_CHANGED })
    await assert.rejects(writeConfinedFile(path, 'planted\n', { exclusive: true }))
    await assert.rejects(readConfinedFile(path, 'utf-8'), { message: CONFINED_FILE_CHANGED })
    assert.equal(await readFile(secret, 'utf-8'), secretText)
  })

  test('a folder on the checked path swapped for a link is refused', async () => {
    await mkdir(join(folder, 'epic'))
    const path = join(folder, 'epic', 'secret.md')
    // The path was checked while `epic` was a folder; now it leads elsewhere.
    await rm(join(folder, 'epic'), { recursive: true })
    await symlink(join(root, 'private'), join(folder, 'epic'))
    await assert.rejects(writeConfinedFile(path, 'planted\n'), { message: CONFINED_FILE_CHANGED })
    await assert.rejects(readConfinedFile(path, 'utf-8'), { message: CONFINED_FILE_CHANGED })
    assert.equal(await readFile(secret, 'utf-8'), secretText)
  })

  test('a file with a second name is neither read nor written, unless the owner’s editor writes it', async () => {
    const path = join(folder, 'hard.md')
    await link(secret, path)
    await assert.rejects(readConfinedFile(path, 'utf-8'), { message: CONFINED_FILE_LINKED })
    await assert.rejects(writeConfinedFile(path, 'planted\n'), { message: CONFINED_FILE_LINKED })
    assert.equal(await readFile(secret, 'utf-8'), secretText)
    await writeConfinedFile(path, 'saved\n', { hardLinks: 'allow' })
    assert.equal(await readFile(secret, 'utf-8'), 'saved\n')
  })

  test('a read past its limit is refused from the size, and a write past it is not made', async () => {
    const path = join(folder, 'big.md')
    // Sparse: a gigabyte on paper, nothing on disk. Read whole, it would be a gigabyte in memory.
    await writeFile(path, '')
    await truncate(path, 1024 * 1024 * 1024)
    const started = Date.now()
    await assert.rejects(readConfinedFile(path), (error) => isConfinedFileTooLarge(error))
    assert.ok(Date.now() - started < 1000, 'refused without reading it')

    await truncate(path, CONFINED_READ_MAX_BYTES + 1)
    await assert.rejects(readConfinedFile(path, 'utf-8'), { message: /over the 1 MB Studio reads here/ })
    assert.equal(
      (await readConfinedFile(path, { maxBytes: CONFINED_READ_MAX_BYTES + 1 })).byteLength,
      CONFINED_READ_MAX_BYTES + 1,
    )
    await truncate(path, CONFINED_READ_MAX_BYTES)
    assert.equal((await readConfinedFile(path)).byteLength, CONFINED_READ_MAX_BYTES, 'the limit itself reads')

    const small = join(folder, 'small.md')
    await assert.rejects(writeConfinedFile(small, 'x'.repeat(11), { maxBytes: 10 }), (error) =>
      isConfinedFileTooLarge(error),
    )
    await assert.rejects(stat(small), { code: 'ENOENT' })
    await writeConfinedFile(small, 'x'.repeat(10), { maxBytes: 10 })
    assert.equal(await readConfinedFile(small, 'utf-8'), 'x'.repeat(10))
  })

  test('a folder is copied file by file, links kept as links, and never into a link', async () => {
    const source = join(root, 'source')
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Skill\n')
    await writeFile(join(source, 'scripts', 'run.sh'), '#!/bin/sh\n')
    await chmod(join(source, 'scripts', 'run.sh'), 0o755)
    await symlink('SKILL.md', join(source, 'alias.md'))

    const destination = await realFolderPath(join(folder, 'skill'))
    await copyConfinedDirectory(source, destination)
    assert.equal(await readFile(join(destination, 'SKILL.md'), 'utf-8'), '# Skill\n')
    assert.equal((await stat(join(destination, 'scripts', 'run.sh'))).mode & 0o777, 0o755)
    assert.equal(await readlink(join(destination, 'alias.md')), join(source, 'SKILL.md'))

    // A link put where the copy goes is not followed.
    await symlink(join(root, 'private'), join(folder, 'linked'))
    await assert.rejects(copyConfinedDirectory(source, join(folder, 'linked')), { code: 'EEXIST' })
    assert.equal(await readFile(secret, 'utf-8'), secretText)
  })
})
