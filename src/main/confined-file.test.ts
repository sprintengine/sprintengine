import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, test } from 'vitest'

import {
  CONFINED_FILE_CHANGED,
  copyConfinedDirectory,
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
