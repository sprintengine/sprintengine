// The files a frame reaches through Studio (`files.read`, `.stat`, `.search`,
// `.write`): only inside a workspace's folder, and never through a link out of
// it, checked the same way on every platform.
//
// 1. The target's real path (for a file to create, its folder's) must lie
//    inside the real path of the workspace's folder, and outside every folder
//    Studio keeps for itself (its data folder, the installed extensions).
// 2. A file is opened with `O_NOFOLLOW` where the platform has it, so a link
//    put in its place after the check is refused rather than followed.
// 3. The opened descriptor's `dev`/`ino` must match a `stat` of the real path
//    taken during the check, before the open: a file, or a folder above it,
//    swapped between the check and the open is refused.
// 4. After the open, the descriptor's own path (Linux: `/proc/self/fd`;
//    elsewhere the real path resolved again) is checked for containment once
//    more, so a folder above the file swapped for a link to somewhere else
//    during the check is caught as well.
// 5. A file with more than one name (`nlink > 1`) is refused: a hard link
//    could alias a file outside the folder without any link to follow.
// 6. A write never opens with `O_TRUNC`: it truncates with `ftruncate` once the
//    checks passed. A create opens with `O_EXCL`, so it never writes through
//    a file or link that appeared meanwhile. Nothing is written under a
//    `.git` folder, whose configuration and hooks git runs.
// 7. A search walks with `lstat`, never follows a link, and checks each
//    folder's real path before reading it.
//
// What stays: on Windows `O_NOFOLLOW` does not exist, and outside Linux the
// re-check of step 4 is a second `realpath`, so a swap made and undone
// between the open and that re-check is not seen. Only another process
// writing in the workspace can race these steps; a frame cannot make links.
//
// Pure Node; the host's gate has already held the call to the extension's
// `workspace-files:*` and the caller's `filesystem:*`.

import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/** The largest file `files.read` answers, and the most `files.write` writes. */
export const EXTENSION_FILE_MAX_BYTES = 4 * 1024 * 1024
/** The most entries one search looks at, and the most it answers. */
const SEARCH_MAX_VISITED = 20_000
const SEARCH_MAX_RESULTS = 500
const SEARCH_DEFAULT_RESULTS = 200
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules'])

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

export class ExtensionFileRefusal extends Error {
  readonly code: 'invalid_params' | 'not_permitted' | 'action_failed'
  constructor(code: ExtensionFileRefusal['code'], message: string) {
    super(message)
    this.name = 'ExtensionFileRefusal'
    this.code = code
  }
}

export type ExtensionFilesScope = {
  /** The workspace's folder, as Studio knows it. */
  root: string
  /** Folders no call may reach even inside the workspace (Studio's data, the installed extensions). */
  forbidden: readonly string[]
  /** Tests only: runs between the check and the open, where another process could swap a path. */
  betweenCheckAndOpen?: () => Promise<void>
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path) && path.split(sep)[0] !== '..')
}

/** A workspace-relative path's parts, or a refusal. */
function partsOf(path: unknown): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0'))
    throw new ExtensionFileRefusal('invalid_params', '"path" is a path inside the workspace, relative to its folder.')
  const parts = path.replaceAll('\\', '/').split('/')
  if (path.startsWith('/') || /^[a-zA-Z]:/u.test(path) || parts.some((part) => !part || part === '.' || part === '..'))
    throw new ExtensionFileRefusal('invalid_params', '"path" is a path inside the workspace, relative to its folder.')
  return parts
}

async function realRoot(scope: ExtensionFilesScope): Promise<{ root: string; forbidden: string[] }> {
  let root: string
  try {
    root = await realpath(scope.root)
  } catch {
    throw new ExtensionFileRefusal('action_failed', 'The workspace’s folder is not there.')
  }
  const forbidden: string[] = []
  for (const folder of scope.forbidden) {
    forbidden.push(await realpath(folder).catch(() => folder))
  }
  return { root, forbidden }
}

function contained(real: string, root: string, forbidden: readonly string[], shown: string): void {
  if (!inside(root, real) || forbidden.some((folder) => inside(folder, real)))
    throw new ExtensionFileRefusal('not_permitted', `${shown} is outside the workspace’s folder.`)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a path inside the workspace passes through a `.git` folder. */
function inGitFolder(root: string, real: string): boolean {
  return relative(root, real)
    .split(sep)
    .some((part) => part.toLowerCase() === '.git')
}

/** Where an open descriptor is now: the kernel's word on Linux, the path resolved again elsewhere. */
async function descriptorPath(handle: FileHandle, path: string): Promise<string> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/self/fd/${handle.fd}`)
    } catch {
      // No /proc: resolve the path again below.
    }
  }
  return realpath(path)
}

/**
 * The descriptor is the file the check found (`checked`, taken before the
 * open), it is still inside the workspace now, and it has one name only.
 */
async function sameFile(
  handle: FileHandle,
  checked: Stats,
  path: string,
  where: { root: string; forbidden: readonly string[] },
  shown: string,
): Promise<Stats> {
  const opened = await handle.stat()
  if (opened.dev !== checked.dev || opened.ino !== checked.ino)
    throw new ExtensionFileRefusal('not_permitted', `${shown} changed while it was opened, so it was not used.`)
  let now: string
  try {
    now = await descriptorPath(handle, path)
  } catch {
    throw new ExtensionFileRefusal('not_permitted', `${shown} moved while it was opened, so it was not used.`)
  }
  contained(now, where.root, where.forbidden, shown)
  if (opened.isFile() && opened.nlink > 1)
    throw new ExtensionFileRefusal(
      'not_permitted',
      `${shown} has more than one name (a hard link), so it was not used.`,
    )
  return opened
}

async function openChecked(
  scope: ExtensionFilesScope,
  path: unknown,
  flags: number,
  writing = false,
): Promise<{ handle: FileHandle; shown: string; stats: Stats }> {
  const parts = partsOf(path)
  const shown = parts.join('/')
  const { root, forbidden } = await realRoot(scope)
  let real: string
  try {
    real = await realpath(join(root, ...parts))
  } catch (error) {
    throw new ExtensionFileRefusal(
      'action_failed',
      missing(error) ? `${shown} does not exist.` : `${shown} cannot be read.`,
    )
  }
  contained(real, root, forbidden, shown)
  if (writing && inGitFolder(root, real))
    throw new ExtensionFileRefusal(
      'not_permitted',
      `${shown} is in a .git folder, which Studio does not write for an extension.`,
    )
  let checked: Stats
  try {
    checked = await stat(real)
  } catch {
    throw new ExtensionFileRefusal('action_failed', `${shown} cannot be opened.`)
  }
  await scope.betweenCheckAndOpen?.()
  let handle: FileHandle
  try {
    handle = await open(real, flags | O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    throw new ExtensionFileRefusal(
      code === 'ELOOP' ? 'not_permitted' : 'action_failed',
      code === 'ELOOP' ? `${shown} became a link, so it was not opened.` : `${shown} cannot be opened.`,
    )
  }
  try {
    return { handle, shown, stats: await sameFile(handle, checked, real, { root, forbidden }, shown) }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function readExtensionFile(
  scope: ExtensionFilesScope,
  path: unknown,
): Promise<{ content: string; size: number }> {
  const { handle, shown, stats } = await openChecked(scope, path, constants.O_RDONLY)
  try {
    if (!stats.isFile()) throw new ExtensionFileRefusal('action_failed', `${shown} is not a file.`)
    if (stats.size > EXTENSION_FILE_MAX_BYTES)
      throw new ExtensionFileRefusal('action_failed', `${shown} is larger than 4 MiB.`)
    const bytes = await handle.readFile()
    return { content: bytes.toString('utf8'), size: bytes.byteLength }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function statExtensionFile(
  scope: ExtensionFilesScope,
  path: unknown,
): Promise<{ type: 'file' | 'directory' | 'other'; size: number; modifiedAt: number }> {
  const parts = partsOf(path)
  const shown = parts.join('/')
  const { root, forbidden } = await realRoot(scope)
  let real: string
  try {
    real = await realpath(join(root, ...parts))
  } catch (error) {
    throw new ExtensionFileRefusal(
      'action_failed',
      missing(error) ? `${shown} does not exist.` : `${shown} cannot be read.`,
    )
  }
  contained(real, root, forbidden, shown)
  const stats = await lstat(real)
  return {
    type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  }
}

export async function writeExtensionFile(
  scope: ExtensionFilesScope,
  path: unknown,
  content: unknown,
  create: boolean,
): Promise<{ size: number; created: boolean }> {
  if (typeof content !== 'string') throw new ExtensionFileRefusal('invalid_params', '"content" is the text to write.')
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > EXTENSION_FILE_MAX_BYTES)
    throw new ExtensionFileRefusal('invalid_params', 'A file Studio writes for an extension is at most 4 MiB.')
  const parts = partsOf(path)
  const shown = parts.join('/')
  const { root, forbidden } = await realRoot(scope)
  // The folder it goes in, by its real path, inside the workspace.
  let folder: string
  try {
    folder = await realpath(join(root, ...parts.slice(0, -1)))
  } catch {
    throw new ExtensionFileRefusal('action_failed', `The folder ${dirname(shown)} does not exist.`)
  }
  contained(folder, root, forbidden, shown)
  if (inGitFolder(root, folder) || basename(shown).toLowerCase() === '.git')
    throw new ExtensionFileRefusal(
      'not_permitted',
      `${shown} is in a .git folder, which Studio does not write for an extension.`,
    )
  let folderChecked: Stats
  try {
    folderChecked = await stat(folder)
  } catch {
    throw new ExtensionFileRefusal('action_failed', `The folder ${dirname(shown)} does not exist.`)
  }
  const target = join(folder, basename(shown))
  let handle: FileHandle
  let created: boolean
  if (create) await scope.betweenCheckAndOpen?.()
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o644)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST')
      throw new ExtensionFileRefusal('action_failed', `${shown} cannot be written.`)
    if (create) throw new ExtensionFileRefusal('action_failed', `${shown} already exists.`)
    // It exists: the real path it names must be inside too, and opened as it is.
    const opened = await openChecked(scope, shown, constants.O_WRONLY, true)
    if (!opened.stats.isFile()) {
      await opened.handle.close().catch(() => undefined)
      throw new ExtensionFileRefusal('action_failed', `${shown} is not a file.`)
    }
    handle = opened.handle
    created = false
  }
  try {
    if (created) {
      // The new file is where the check said, under the folder it checked.
      const now = await descriptorPath(handle, target).catch(() => '')
      if (dirname(now) !== folder) {
        const where = await stat(dirname(now)).catch(() => null)
        if (!where || where.dev !== folderChecked.dev || where.ino !== folderChecked.ino)
          throw new ExtensionFileRefusal('not_permitted', `${shown} moved while it was made, so nothing was written.`)
      }
      contained(now, root, forbidden, shown)
    } else await handle.truncate(0)
    await handle.write(bytes, 0, bytes.byteLength, 0)
    return { size: bytes.byteLength, created }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function searchExtensionFiles(
  scope: ExtensionFilesScope,
  query: unknown,
  limit: unknown,
): Promise<{ paths: string[]; truncated: boolean }> {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200)
    throw new ExtensionFileRefusal('invalid_params', '"query" is part of a file’s name.')
  const most =
    typeof limit === 'number' && Number.isInteger(limit) && limit > 0
      ? Math.min(limit, SEARCH_MAX_RESULTS)
      : SEARCH_DEFAULT_RESULTS
  const needle = query.trim().toLowerCase()
  const { root, forbidden } = await realRoot(scope)
  const paths: string[] = []
  let visited = 0
  let truncated = false
  const queue: string[] = [root]
  while (queue.length > 0) {
    const folder = queue.shift()!
    let names: string[]
    try {
      // A folder swapped for a link after it was listed is not read.
      const real = await realpath(folder)
      if (!inside(root, real) || forbidden.some((denied) => inside(denied, real))) continue
      names = (await readdir(real)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      visited += 1
      if (visited > SEARCH_MAX_VISITED || paths.length >= most) {
        truncated = true
        return { paths, truncated }
      }
      const full = join(folder, name)
      let stats: Stats
      try {
        stats = await lstat(full)
      } catch {
        continue
      }
      if (forbidden.some((denied) => inside(denied, full))) continue
      if (name.toLowerCase().includes(needle)) paths.push(relative(root, full).split(sep).join('/'))
      // A link is listed by its own name and never walked into.
      if (stats.isDirectory() && !stats.isSymbolicLink() && !SKIPPED_FOLDERS.has(name)) queue.push(full)
    }
  }
  return { paths, truncated }
}
