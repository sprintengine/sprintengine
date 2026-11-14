import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, symlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// Reading and writing a file whose path was checked first. Every write (and
// every read that is cheap to hold the same way) held to a folder, such as a
// backlog item, an editor save or a file a paired device names, resolves the
// file's real path, checks it is inside the folder, and then does the work on
// that path. A plain `writeFile` after the check follows a link that was put
// at the path in between, wherever it points. These open the path without
// following a link at it (O_NOFOLLOW; Windows has no such flag, so there the
// path is checked to be no link just before it is opened), then check that
// the file opened is the one now at the checked path, in the folder that
// path names, before a byte is read or written.
//
// `path` must be the real path the caller checked: its folder resolves to
// itself. A folder above it swapped for a link and back again between the
// checks is not caught; only a descriptor-relative open could, and Node has
// none.

export const CONFINED_FILE_CHANGED =
  'That file was replaced by a link while Studio opened it, so Studio did not touch it. Try again.'

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

class ConfinedFileChanged extends Error {
  readonly code = 'ECONFINEDCHANGED'
  constructor() {
    super(CONFINED_FILE_CHANGED)
  }
}

async function folderIsReal(folder: string): Promise<boolean> {
  return (await realpath(folder).catch(() => null)) === folder
}

async function openConfined(path: string, flags: number): Promise<FileHandle> {
  const folder = dirname(path)
  if (!(await folderIsReal(folder))) throw new ConfinedFileChanged()
  if (NO_FOLLOW === 0) {
    const named = await lstat(path).catch(() => null)
    if (named?.isSymbolicLink()) throw new ConfinedFileChanged()
  }
  let handle: FileHandle
  try {
    handle = await open(path, flags | NO_FOLLOW, 0o666)
  } catch (error) {
    // O_NOFOLLOW refuses a link at the path with ELOOP (EMLINK on some BSDs).
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') throw new ConfinedFileChanged()
    throw error
  }
  try {
    const [opened, named, stillReal] = await Promise.all([
      handle.stat(),
      lstat(path).catch(() => null),
      folderIsReal(folder),
    ])
    if (!opened.isFile()) throw new Error('Only files can be read or written here.')
    if (!named || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || !stillReal)
      throw new ConfinedFileChanged()
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/**
 * Write `data` to the file at the real path `path`, creating it when it is
 * missing (or only then, with `exclusive`, failing with EEXIST otherwise, as
 * the `wx` flag does). The file is emptied only once it is known to be the
 * one at `path`. `mode` sets its permission bits, as a copy keeps them.
 */
export async function writeConfinedFile(
  path: string,
  data: string | Uint8Array,
  options: { exclusive?: boolean; mode?: number } = {},
): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | (options.exclusive ? constants.O_EXCL : 0)
  const handle = await openConfined(path, flags)
  try {
    if (!options.exclusive) await handle.truncate(0)
    if (options.mode !== undefined) await handle.chmod(options.mode)
    await handle.writeFile(data, typeof data === 'string' ? 'utf-8' : undefined)
  } finally {
    await handle.close()
  }
}

/** Read the file at the real path `path`, refusing anything but a regular file there. */
export async function readConfinedFile(path: string): Promise<Buffer>
export async function readConfinedFile(path: string, encoding: 'utf-8'): Promise<string>
export async function readConfinedFile(path: string, encoding?: 'utf-8'): Promise<Buffer | string> {
  // Non-blocking, so a FIFO put at the path cannot hang the open before the stat refuses it.
  const handle = await openConfined(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const bytes = await handle.readFile()
    return encoding ? bytes.toString(encoding) : bytes
  } finally {
    await handle.close()
  }
}

/** Where `path` would be with its folder's links followed: the real path a confined write takes. */
export async function realFolderPath(path: string): Promise<string> {
  return join(await realpath(dirname(path)), basename(path))
}

/**
 * Copy the folder `source` to `destination`, which must not exist yet and
 * whose folder is real (`realFolderPath`). Every folder is made, and every
 * file written, without following a link put in the copy's way; a link in
 * the source is copied as a link to where it points, as `cp` does.
 */
export async function copyConfinedDirectory(source: string, destination: string): Promise<void> {
  if (!(await folderIsReal(dirname(destination)))) throw new ConfinedFileChanged()
  // mkdir refuses (EEXIST) anything already at the path, a link included.
  await mkdir(destination)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyConfinedDirectory(from, to)
    else if (entry.isSymbolicLink()) {
      const points = await readlink(from)
      await symlink(isAbsolute(points) ? points : resolve(source, points), to)
    } else if (entry.isFile())
      await writeConfinedFile(to, await readFile(from), { exclusive: true, mode: (await lstat(from)).mode & 0o7777 })
  }
}
