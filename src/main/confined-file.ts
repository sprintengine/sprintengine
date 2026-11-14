import { constants, type Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
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
// A file with a second name (a hard link) is refused too: the second name can
// be anywhere on the same disk, so the folder's file may really be one of the
// person's files elsewhere, and no path check can tell. And a read takes at
// most `maxBytes` (`CONFINED_READ_MAX_BYTES` unless the caller says), refused
// from the opened file's size before a byte is held, so a huge file put in
// the folder cannot fill the process's memory.
//
// `path` must be the real path the caller checked: its folder resolves to
// itself. A folder above it swapped for a link and back again between the
// checks is not caught; only a descriptor-relative open could, and Node has
// none.

export const CONFINED_FILE_CHANGED =
  'That file was replaced by a link while Studio opened it, so Studio did not touch it. Try again.'

export const CONFINED_FILE_LINKED =
  'That file has a second name elsewhere on this disk (a hard link), so Studio did not touch it.'

/** The most a confined read takes unless its caller says otherwise: what a project file read gives a client. */
export const CONFINED_READ_MAX_BYTES = 1024 * 1024

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

class ConfinedFileChanged extends Error {
  readonly code = 'ECONFINEDCHANGED'
  constructor() {
    super(CONFINED_FILE_CHANGED)
  }
}

class ConfinedFileLinked extends Error {
  readonly code = 'ECONFINEDLINKED'
  constructor() {
    super(CONFINED_FILE_LINKED)
  }
}

class ConfinedFileTooLarge extends Error {
  readonly code = 'ECONFINEDTOOLARGE'
  constructor(verb: 'reads' | 'writes', bytes: number, limit: number) {
    super(`That file is ${describeBytes(bytes)}, over the ${describeBytes(limit)} Studio ${verb} here.`)
  }
}

/** Whether `error` is a confined read or write refused for its size. */
export function isConfinedFileTooLarge(error: unknown): boolean {
  return error instanceof ConfinedFileTooLarge
}

/** Whether `error` is a confined read or write refused for what is at the path (a link, a second name, its size): its message says which. */
export function isConfinedFileRefusal(error: unknown): error is Error {
  return (
    error instanceof ConfinedFileChanged || error instanceof ConfinedFileLinked || error instanceof ConfinedFileTooLarge
  )
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

type Opened = { handle: FileHandle; stat: Stats }

async function folderIsReal(folder: string): Promise<boolean> {
  return (await realpath(folder).catch(() => null)) === folder
}

async function openConfined(path: string, flags: number, hardLinks: 'refuse' | 'allow'): Promise<Opened> {
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
    if (!named || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || !stillReal) {
      // A file this open made (O_EXCL), through a folder swapped for a link,
      // is taken away again where the name still leads to it.
      if (flags & constants.O_EXCL && named && named.dev === opened.dev && named.ino === opened.ino)
        await unlink(path).catch(() => undefined)
      throw new ConfinedFileChanged()
    }
    if (hardLinks === 'refuse' && opened.nlink > 1) throw new ConfinedFileLinked()
    return { handle, stat: opened }
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
 * `maxBytes` refuses more data than that. `hardLinks: 'allow'` writes a file
 * that has a second name too: only for the owner's own editor, which may
 * write any file it can name anyway.
 */
export async function writeConfinedFile(
  path: string,
  data: string | Uint8Array,
  options: { exclusive?: boolean; mode?: number; maxBytes?: number; hardLinks?: 'allow' } = {},
): Promise<void> {
  if (options.maxBytes !== undefined) {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf-8') : data.byteLength
    if (bytes > options.maxBytes) throw new ConfinedFileTooLarge('writes', bytes, options.maxBytes)
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | (options.exclusive ? constants.O_EXCL : 0)
  const { handle } = await openConfined(path, flags, options.hardLinks ?? 'refuse')
  try {
    if (!options.exclusive) await handle.truncate(0)
    if (options.mode !== undefined) await handle.chmod(options.mode)
    await handle.writeFile(data, typeof data === 'string' ? 'utf-8' : undefined)
  } finally {
    await handle.close()
  }
}

export type ConfinedReadOptions = {
  /** The most it reads; a larger file is refused unread. `CONFINED_READ_MAX_BYTES` by default. */
  maxBytes?: number
}

/** Read the file at the real path `path`, refusing anything but a regular file there, of at most `maxBytes`. */
export async function readConfinedFile(path: string, options?: ConfinedReadOptions): Promise<Buffer>
export async function readConfinedFile(path: string, encoding: 'utf-8', options?: ConfinedReadOptions): Promise<string>
export async function readConfinedFile(
  path: string,
  encodingOrOptions?: 'utf-8' | ConfinedReadOptions,
  readOptions: ConfinedReadOptions = {},
): Promise<Buffer | string> {
  const encoding = typeof encodingOrOptions === 'string' ? encodingOrOptions : undefined
  const limit =
    (typeof encodingOrOptions === 'object' ? encodingOrOptions.maxBytes : readOptions.maxBytes) ??
    CONFINED_READ_MAX_BYTES
  // Non-blocking, so a FIFO put at the path cannot hang the open before the stat refuses it.
  const { handle, stat } = await openConfined(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0), 'refuse')
  try {
    // Refused from its size before anything is held; one that grows while it
    // is read is refused once it passes the limit, not read to its end.
    if (stat.size > limit) throw new ConfinedFileTooLarge('reads', stat.size, limit)
    const chunks: Buffer[] = []
    let total = 0
    let want = stat.size + 1
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(want, limit + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      if (total > limit) throw new ConfinedFileTooLarge('reads', total, limit)
      want = 64 * 1024
    }
    const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total)
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
 * the source is copied as a link to where it points, as `cp` does. The
 * source is Studio's own (a skill, a bundle the person chose): a file there
 * with a second name is copied.
 */
export async function copyConfinedDirectory(source: string, destination: string): Promise<void> {
  await copyConfinedTree(await realpath(source), destination, { hardLinks: 'allow' })
}

export type ConfinedCopyOptions = {
  /** Replace a file at the destination, and copy into a folder already there, as `cp --force` does. */
  overwrite?: boolean
  /**
   * `allow`: copy a file with a second name (a hard link), and replace one.
   * Only for the owner, who may name that file anyway: a client held to a
   * folder would read or write a file elsewhere through it.
   */
  hardLinks?: 'allow' | 'refuse'
}

/**
 * Copy the file or folder at the real path `source` to `destination`, whose
 * folder is real. As `copyConfinedDirectory`, every file is read and written
 * without following a link put in the copy's way, and a file is streamed, so
 * a large one is not held in memory.
 */
export async function copyConfined(
  source: string,
  destination: string,
  options: ConfinedCopyOptions = {},
): Promise<void> {
  const from = await lstat(source)
  if (from.isDirectory()) await copyConfinedTree(source, destination, options)
  else if (from.isSymbolicLink()) await copyConfinedLink(source, destination, options)
  else await copyConfinedFile(source, destination, options)
}

async function copyConfinedTree(source: string, destination: string, options: ConfinedCopyOptions): Promise<void> {
  if (!(await folderIsReal(dirname(destination)))) throw new ConfinedFileChanged()
  try {
    // mkdir refuses (EEXIST) anything already at the path, a link included.
    await mkdir(destination)
  } catch (error) {
    // Copied into a folder already there only when asked, and only a folder: never a link to one.
    if (!options.overwrite || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await lstat(destination)).isDirectory()) throw error
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyConfinedTree(from, to, options)
    else if (entry.isSymbolicLink()) await copyConfinedLink(from, to, options)
    else if (entry.isFile()) await copyConfinedFile(from, to, options)
  }
}

async function copyConfinedLink(source: string, destination: string, options: ConfinedCopyOptions): Promise<void> {
  const points = await readlink(source)
  if (!(await folderIsReal(dirname(destination)))) throw new ConfinedFileChanged()
  if (options.overwrite) {
    // `unlink` takes away the name, a link included, and never follows it.
    const there = await lstat(destination).catch(() => null)
    if (there && !there.isDirectory()) await unlink(destination)
  }
  await symlink(isAbsolute(points) ? points : resolve(dirname(source), points), destination)
}

async function copyConfinedFile(source: string, destination: string, options: ConfinedCopyOptions): Promise<void> {
  const hardLinks = options.hardLinks ?? 'refuse'
  const from = await openConfined(source, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0), hardLinks)
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | (options.overwrite ? 0 : constants.O_EXCL)
    const { handle: to } = await openConfined(destination, flags, hardLinks)
    try {
      if (options.overwrite) await to.truncate(0)
      await to.chmod(from.stat.mode & 0o7777)
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      for (let position = 0; ;) {
        const { bytesRead } = await from.handle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        await to.write(buffer, 0, bytesRead, position)
        position += bytesRead
      }
    } finally {
      await to.close()
    }
  } finally {
    await from.handle.close()
  }
}

/**
 * Move (or rename) the file or folder at the real path `source` to
 * `destination`, where nothing is yet, in a real folder. A rename follows a
 * folder on either path swapped for a link after they were checked, and Node
 * has no rename that does not: so the folders are checked again once it is
 * done, and a move that went elsewhere is put back and refused.
 */
export async function moveConfined(source: string, destination: string): Promise<void> {
  const folders = [dirname(source), dirname(destination)]
  const real = async () => (await Promise.all(folders.map(folderIsReal))).every(Boolean)
  if (!(await real())) throw new ConfinedFileChanged()
  // A rename replaces what is at its destination, a link included: there must be nothing.
  if (
    await lstat(destination).then(
      () => true,
      () => false,
    )
  )
    throw Object.assign(new Error(`${basename(destination)} already exists.`), { code: 'EEXIST' })
  await rename(source, destination)
  if (!(await real())) {
    await rename(destination, source).catch(() => undefined)
    throw new ConfinedFileChanged()
  }
}
