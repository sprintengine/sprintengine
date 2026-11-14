import assert from 'node:assert/strict'
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// A step run once, right after the next `realpath` of a given path answers:
// how a test puts a link in place between a path's check and its use.
const afterRealpath = vi.hoisted(() => ({ at: null as null | { path: string; run: () => Promise<void> } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = (async (path: string, options?: unknown) => {
    const answer = await (actual.realpath as (path: string, options?: unknown) => Promise<string>)(path, options)
    const step = afterRealpath.at
    if (step && path === step.path) {
      afterRealpath.at = null
      await step.run()
    }
    return answer
  }) as typeof actual.realpath
  return { ...actual, realpath, default: { ...actual, realpath } }
})

import { createStudioFileSystem } from './studio-file-system'

// The core's files by path, on a real disk: what each change does, and the
// words it refuses in. Who may name which path is the router's
// (`rpc/studio-file-system.test.ts`).

function files() {
  return createStudioFileSystem({ readableRoots: () => [], writableRoots: () => [], trash: async () => undefined })
}

test('copies, renames, moves and dropped pictures', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-fs-mutation-'))
  const files = createStudioFileSystem({ readableRoots: () => [], writableRoots: () => [] })
  try {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])

    const savedPath = await files.saveDroppedImage({
      mediaType: 'image/png',
      dataBase64: pngBytes.toString('base64'),
    })
    try {
      assert.ok(savedPath.endsWith('.png'), 'saved image wears the extension of its media type')
      assert.deepEqual(await readFile(savedPath), pngBytes, 'saved image holds the decoded bytes')
    } finally {
      await rm(savedPath, { force: true })
    }
    await assert.rejects(
      () => files.saveDroppedImage({ mediaType: 'image/svg+xml', dataBase64: pngBytes.toString('base64') }),
      /Only PNG, JPEG, WebP, and GIF/,
      'non-attachable media types are refused',
    )
    await assert.rejects(
      () => files.saveDroppedImage({ mediaType: 'image/png', dataBase64: '' }),
      /could not be read/,
      'an empty payload is refused rather than written as a zero-byte file',
    )

    const sourceRoot = join(tempRoot, 'registry')
    const sourceManifestsDir = join(sourceRoot, 'manifests')
    const sourceSkillsDir = join(sourceRoot, 'skills')
    const sourceSkillDir = join(sourceSkillsDir, 'growth-copywriter')
    const destinationRoot = join(tempRoot, 'workspace', '.sprintengine')
    const destinationManifestsDir = join(destinationRoot, 'manifests')
    const destinationSkillsDir = join(destinationRoot, 'skills')
    await mkdir(sourceManifestsDir, { recursive: true })
    await mkdir(sourceSkillDir, { recursive: true })
    await mkdir(destinationManifestsDir, { recursive: true })
    await mkdir(destinationSkillsDir, { recursive: true })
    await writeFile(
      join(sourceManifestsDir, 'marketer.json'),
      '{"id":"marketer","skills":["growth-copywriter"]}',
      'utf-8',
    )
    await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Growth Copywriter\n', 'utf-8')

    const copiedManifestPath = await files.copy(
      join(sourceManifestsDir, 'marketer.json'),
      destinationManifestsDir,
      'overwrite',
      true,
    )
    const copiedSkillPath = await files.copy(sourceSkillDir, destinationSkillsDir, 'overwrite', true)

    assert.equal(
      copiedManifestPath,
      join(destinationManifestsDir, 'marketer.json'),
      'manifests copy under their original file name',
    )
    assert.equal(
      copiedSkillPath,
      join(destinationSkillsDir, 'growth-copywriter'),
      'skill folders copy under their original directory name',
    )
    assert.equal(
      await readFile(join(destinationSkillsDir, 'growth-copywriter', 'SKILL.md'), 'utf-8'),
      '# Growth Copywriter\n',
      'skill content remains discoverable at skills/<skill-id>/SKILL.md',
    )

    await writeFile(join(sourceSkillDir, 'SKILL.md'), '# Growth Copywriter v2\n', 'utf-8')
    await files.copy(sourceSkillDir, destinationSkillsDir, 'overwrite', true)
    assert.equal(
      await readFile(join(destinationSkillsDir, 'growth-copywriter', 'SKILL.md'), 'utf-8'),
      '# Growth Copywriter v2\n',
      'overwrite updates existing installed skill folders without copy suffixes',
    )

    const renameSource = join(tempRoot, 'plan.md')
    await writeFile(renameSource, '# Plan\n', 'utf-8')
    await assert.rejects(
      () => files.rename(renameSource, 'CON.md', true),
      /reserved by Windows/,
      'rename rejects Windows reserved names',
    )
    await assert.rejects(
      () => files.rename(renameSource, 'bad:name.md', true),
      /cannot contain control characters/,
      'rename rejects Windows-invalid filename characters',
    )
    await assert.rejects(
      () => files.rename(renameSource, 'trailing-space.md ', true),
      /cannot end with a period or space/,
      'rename rejects trailing spaces before filesystem mutation',
    )
    assert.equal(
      await readFile(renameSource, 'utf-8'),
      '# Plan\n',
      'invalid rename attempts leave source file in place',
    )

    const moveSourceDir = join(tempRoot, 'move-source')
    const moveDestinationDir = join(tempRoot, 'move-destination')
    await mkdir(moveSourceDir)
    await mkdir(moveDestinationDir)
    const moveSourceFile = join(moveSourceDir, 'notes.md')
    await writeFile(moveSourceFile, '# Notes\n', 'utf-8')

    const movedFilePath = await files.move(moveSourceFile, moveDestinationDir, true)
    assert.equal(
      movedFilePath,
      join(moveDestinationDir, 'notes.md'),
      'move returns the file path under the destination directory',
    )
    assert.equal(await readFile(movedFilePath, 'utf-8'), '# Notes\n', 'move carries file content to destination')
    await assert.rejects(() => stat(moveSourceFile), /ENOENT/, 'move removes the original file path')

    const collisionSource = join(moveSourceDir, 'notes.md')
    await writeFile(collisionSource, '# Collision\n', 'utf-8')
    await assert.rejects(
      () => files.move(collisionSource, moveDestinationDir, true),
      /already exists/,
      'move rejects destination name collisions',
    )
    assert.equal(await readFile(collisionSource, 'utf-8'), '# Collision\n', 'collision leaves source file in place')

    const moveParentDir = join(tempRoot, 'move-parent')
    const nestedDestinationDir = join(moveParentDir, 'nested')
    await mkdir(nestedDestinationDir, { recursive: true })
    await assert.rejects(
      () => files.move(moveParentDir, nestedDestinationDir, true),
      /Cannot move a file or folder into itself\./,
      'move rejects moving a folder into its own child',
    )
  } finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
})

test('a Studio with no Trash says so rather than removing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-fs-trash-'))
  try {
    await writeFile(join(root, 'keep.md'), 'keep')
    await assert.rejects(
      createStudioFileSystem({ readableRoots: () => [], writableRoots: () => [] }).trash(join(root, 'keep.md')),
      /cannot reach a Trash/,
    )
    assert.equal(await readFile(join(root, 'keep.md'), 'utf8'), 'keep')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

describe('new files and folders are named, never placed by path', () => {
  let root: string
  let parent: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sprintengine-fs-names-'))
    parent = await files().createDirectory(root, 'project', 'keep')
  })
  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  const makers = {
    createFile: (at: string, name: string) => files().createFile(at, name),
    createDirectory: (at: string, name: string) => files().createDirectory(at, name),
    'createDirectory (keep)': (at: string, name: string) => files().createDirectory(at, name, 'keep'),
  }
  for (const [kind, make] of Object.entries(makers)) {
    test(`${kind} refuses a name that leaves its folder`, async () => {
      for (const name of ['../escape', '..', '.', 'a/b', 'a\\b', '', 'trailing.']) {
        await expect(make(parent, name)).rejects.toThrow()
      }
      expect(await readdir(root)).toEqual(['project'])
      expect(await readdir(parent)).toEqual([])
    })

    test(`${kind} still makes an ordinary name`, async () => {
      const made = await make(parent, 'notes.md')
      expect(made).toBe(join(parent, 'notes.md'))
      await expect(stat(made)).resolves.toBeTruthy()
    })
  }
})

// A save is checked, then written: a link put at the file between the two must
// not carry the save to the file it points at.
test.runIf(process.platform !== 'win32')(
  'a link swapped in after a save is checked is not written through',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-fs-swap-')))
    const project = join(root, 'project')
    const file = join(project, 'notes.md')
    const secret = join(root, 'private', 'secret.md')
    try {
      await mkdir(project)
      await mkdir(join(root, 'private'))
      await writeFile(secret, 'PRIVATE_CANARY\n')
      await writeFile(file, 'notes\n')
      afterRealpath.at = {
        path: project,
        run: async () => {
          await rm(file)
          await symlink(secret, file)
        },
      }
      await expect(files().writeText(file, 'saved\n', [project], false)).rejects.toThrow()
      expect(afterRealpath.at).toBeNull()
      expect(await readFile(secret, 'utf-8')).toBe('PRIVATE_CANARY\n')
    } finally {
      afterRealpath.at = null
      await rm(root, { recursive: true, force: true })
    }
  },
)

// A file with a second name elsewhere (a hard link) is the file elsewhere: a
// client held to known folders does not save through it; the owner, who may
// name that file anyway, does.
test.runIf(process.platform !== 'win32')('a save to a file with a second name is the owner’s alone', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-fs-hardlink-')))
  const project = join(root, 'project')
  const file = join(project, 'notes.md')
  const secret = join(root, 'private', 'secret.md')
  try {
    await mkdir(project)
    await mkdir(join(root, 'private'))
    await writeFile(secret, 'PRIVATE_CANARY\n')
    await link(secret, file)
    await expect(files().writeText(file, 'held\n', [project], false)).rejects.toThrow(/hard link/)
    expect(await readFile(secret, 'utf-8')).toBe('PRIVATE_CANARY\n')
    await files().writeText(file, 'owner\n', [project], true)
    expect(await readFile(secret, 'utf-8')).toBe('owner\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A client held to known folders names real paths the router checked; a
// folder or file on them swapped for a link after the check must not carry
// a copy, a move or a rename anywhere else.
test.runIf(process.platform !== 'win32')(
  'a link swapped in after a copy or move is checked is not followed',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-fs-copy-swap-')))
    const project = join(root, 'project')
    const outside = join(root, 'private')
    const secret = join(outside, 'secret.md')
    const source = join(project, 'notes.md')
    const into = join(project, 'into')
    const swap = async () => {
      await rm(into, { recursive: true, force: true })
      await symlink(outside, into)
    }
    try {
      await mkdir(project)
      await mkdir(outside)
      await writeFile(secret, 'PRIVATE_CANARY\n')
      await writeFile(source, 'notes\n')

      // Swapped between the router's check and the work.
      await mkdir(into)
      await swap()
      await expect(files().copy(source, into, 'fail', false)).rejects.toThrow()
      await mkdir(join(project, 'folder'))
      await writeFile(join(project, 'folder', 'a.md'), 'a\n')
      await expect(files().copy(join(project, 'folder'), into, 'rename', false)).rejects.toThrow()
      await expect(files().move(source, into, false)).rejects.toThrow()
      expect(await readdir(outside)).toEqual(['secret.md'])
      expect(await readFile(source, 'utf-8')).toBe('notes\n')

      // A file to overwrite swapped for a link to one elsewhere.
      await rm(into)
      await mkdir(into)
      await symlink(secret, join(into, 'notes.md'))
      await expect(files().copy(source, into, 'overwrite', false)).rejects.toThrow()
      expect(await readFile(secret, 'utf-8')).toBe('PRIVATE_CANARY\n')

      // Swapped while the move runs: put back, and refused.
      await rm(into, { recursive: true })
      await mkdir(into)
      afterRealpath.at = { path: into, run: swap }
      await expect(files().move(source, into, false)).rejects.toThrow(/replaced by a link/)
      expect(afterRealpath.at).toBeNull()
      expect(await readdir(outside)).toEqual(['secret.md'])
      expect(await readFile(source, 'utf-8')).toBe('notes\n')

      // And while a copy runs: nothing of it is left there.
      await rm(into)
      await mkdir(into)
      afterRealpath.at = { path: into, run: swap }
      await expect(files().copy(source, into, 'fail', false)).rejects.toThrow(/replaced by a link/)
      expect(afterRealpath.at).toBeNull()
      expect(await readdir(outside)).toEqual(['secret.md'])
    } finally {
      afterRealpath.at = null
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.runIf(process.platform !== 'win32')(
  'a held copy refuses a file with a second name; the owner’s copies it',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-fs-copy-hardlink-')))
    const project = join(root, 'project')
    const secret = join(root, 'private', 'secret.md')
    try {
      await mkdir(join(project, 'into'), { recursive: true })
      await mkdir(join(root, 'private'))
      await writeFile(secret, 'PRIVATE_CANARY\n')
      await link(secret, join(project, 'hard.md'))
      await expect(files().copy(join(project, 'hard.md'), join(project, 'into'), 'fail', false)).rejects.toThrow(
        /hard link/,
      )
      await expect(stat(join(project, 'into', 'hard.md'))).rejects.toThrow()
      await files().copy(join(project, 'hard.md'), join(project, 'into'), 'fail', true)
      expect(await readFile(join(project, 'into', 'hard.md'), 'utf-8')).toBe('PRIVATE_CANARY\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
