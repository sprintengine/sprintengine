import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  ContentSearchResult,
  FileWatchEvent,
  ProjectLogo,
  StudioCopyConflict,
  StudioDirectoryEntry,
  StudioFileSearchResult,
  StudioPathStat,
  WorkspaceFolderCheckResult,
} from '../../../packages/studio-protocol/src/public'
import { writeAttachmentImageFile } from '../../main/attachment-image-file'
import { writeConfinedFile } from '../../main/confined-file'
import { resolveEditorSaveTarget } from '../../main/editor-save-target'
import { getUniqueCopyPath } from '../../main/filesystem-copy'
import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import type { FileSearchRequest } from '../../main/filesystem-search'
import { isMissingPathError, pathExists } from '../../main/filesystem-workspace'
import { gitRepoRootFor } from '../../main/git-repo-root'
import type { ProjectLogoIo } from '../../main/project-logo'
import { getWatchHub, type WatchHub } from '../../main/workspace-watch-hub'
import { imageWithinDecodeLimits } from '../../shared/image-dimensions'

// The files on this Studio's machine, by absolute path: what the protocol's
// `files.*` methods by path and the `files.watchPath` stream do here
// (`file-system.ts` in the protocol). The core builds one for every server,
// so a desktop, a WSL distribution's server and an SSH machine's server each
// answer for their own disk. It holds no rule about who asks: the router's
// handlers (`rpc/studio-file-system.ts`) resolve and hold a path before any
// call here, and an owner's own path reaches it as written.
//
// What only a desktop's shell can do is handed in: moving a file to the
// Trash, and decoding a picture to shrink a logo. A Studio without them says
// so for the Trash and serves a logo at its own bytes.

/** What the shell around a Studio adds to its files, where it has them. */
export type StudioFileSystemShell = {
  /** Move a file or folder to this machine's Trash. */
  trash?: (path: string) => Promise<void>
  /** Read a project's logo, with the shell's image codec to shrink one. */
  projectLogoIo?: ProjectLogoIo
  /** Where a new project's folder goes by default, as the shell names this machine's Documents. */
  defaultWorkspaceParent?: () => string | null
}

export type StudioFileSystemOptions = StudioFileSystemShell & {
  /** The folders a client held to known folders may read in: the workspaces' and Studio's stores of what chats sent. */
  readableRoots(): readonly string[] | Promise<readonly string[]>
  /** The folders such a client may change: the workspaces' own. */
  writableRoots(): readonly string[] | Promise<readonly string[]>
  /** Injectable for tests; the process-wide hub otherwise. */
  watchHub?: WatchHub
}

export type StudioFileSystemWatch = { ok: true; dispose(): void } | { ok: false; message: string }

export type StudioFileSystem = {
  readableRoots(): Promise<readonly string[]>
  writableRoots(): Promise<readonly string[]>
  listDirectory(path: string): Promise<StudioDirectoryEntry[]>
  /** `confined`: `path` is a real path checked to be inside a folder; a link put there since is not followed. */
  readText(path: string, options?: { confined?: boolean }): Promise<string>
  readImage(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<StudioPathStat>
  checkWorkspaceFolder(path: string): Promise<WorkspaceFolderCheckResult>
  projectLogo(folderPath: string): Promise<ProjectLogo | null>
  projectIcon(path: string): Promise<ProjectLogo | null>
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
  /** Search by file name; a newer search in the same slot (and channel) ends the one before. */
  searchFiles(slot: number, input: FileSearchRequest): Promise<StudioFileSearchResult>
  cancelFileSearch(slot: number, channel?: string): void
  searchContent(slot: number, input: { rootPath: string; query: string; limit?: number }): Promise<ContentSearchResult>
  cancelContentSearch(slot: number): void
  /** A connection went: its searches end. */
  releaseSlot(slot: number): void
  defaultWorkspaceParent(): string | null
  writeText(path: string, text: string, roots: readonly string[]): Promise<void>
  saveDroppedImage(input: { mediaType: string; dataBase64: string }): Promise<string>
  createFile(parentPath: string, name: string): Promise<string>
  createDirectory(parentPath: string, name: string, existing?: 'keep'): Promise<string>
  rename(path: string, name: string): Promise<string>
  copy(path: string, toFolder: string, onConflict: StudioCopyConflict): Promise<string>
  move(path: string, toFolder: string): Promise<string>
  trash(path: string): Promise<void>
  /** Hear changes under a folder until disposed. A folder that is not there is answered so. */
  watch(
    path: string,
    includeIgnored: boolean,
    listener: (event: FileWatchEvent) => void,
  ): Promise<StudioFileSystemWatch>
}

/**
 * One name, never a path: what a rename, a new file or a new folder is
 * called stays in the folder it was made in. Refused with words a person
 * can act on.
 */
export function normalizeEntryName(rawName: string): string {
  if (/[. ]$/u.test(rawName)) throw new Error('File and folder names cannot end with a period or space.')
  const name = rawName.trim()
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name))
    throw new Error('Enter a valid file or folder name.')
  if (/[\u0000-\u001f<>:"|?*]/u.test(name))
    throw new Error('File and folder names cannot contain control characters or <>:"|?*.')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name))
    throw new Error('That file or folder name is reserved by Windows.')
  return name
}

function isInsideOrEqual(childPath: string, parentPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** A project logo's reads with no image codec: a picture too large to show as it is is not shrunk but refused by the guard. */
export function plainProjectLogoIo(): ProjectLogoIo {
  return {
    async readdir(dirPath: string): Promise<string[]> {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)
    },
    async stat(filePath: string) {
      const stats = await stat(filePath)
      return { isFile: stats.isFile(), size: stats.size, mtimeMs: stats.mtimeMs }
    },
    readFile,
    realpath,
    async downscaleRaster(bytes: Buffer, mimeType: string) {
      if (!imageWithinDecodeLimits(bytes)) throw new Error('That picture is too large to decode.')
      return { bytes, mimeType }
    },
    join,
  }
}

function defaultParent(): string | null {
  const home = homedir()
  if (!home) return null
  const documents = join(home, 'Documents')
  return existsSync(documents) ? documents : home
}

// The searches load on first use: they bring packages (an ignore-file parser)
// that a server bundle loads from beside it, and a server checks what it
// needs before it loads anything else.
const searches = () => import('../../main/filesystem-search')

export function createStudioFileSystem(options: StudioFileSystemOptions): StudioFileSystem {
  const reads = createFilesystemReadHandlers({ projectLogoIo: options.projectLogoIo ?? plainProjectLogoIo() })
  const hub = options.watchHub ?? getWatchHub()

  return {
    readableRoots: async () => [...(await options.readableRoots())],
    writableRoots: async () => [...(await options.writableRoots())],
    listDirectory: (path) => reads.readDirectory(path),
    readText: (path, readOptions) => reads.readTextFile(path, readOptions),
    readImage: (path) => reads.readImageDataUrl(path),
    exists: (path) => pathExists(path),
    stat: (path) => reads.statPath(path),
    checkWorkspaceFolder: (path) => reads.checkWorkspaceFolder(path),
    projectLogo: (folderPath) => reads.detectProjectLogo(folderPath),
    projectIcon: (path) => reads.readProjectIconFile(path),
    repoRoot: (folderPath, hostId) => gitRepoRootFor(folderPath, hostId),
    searchFiles: async (slot, input) => (await searches()).searchFiles(slot, input),
    cancelFileSearch: (slot, channel) => void searches().then((search) => search.cancelActiveFileSearch(slot, channel)),
    searchContent: async (slot, input) => (await searches()).searchContent(slot, input),
    cancelContentSearch: (slot) => void searches().then((search) => search.cancelActiveContentSearch(slot)),
    releaseSlot: (slot) =>
      void searches().then((search) => {
        search.cancelAllFileSearches(slot)
        search.cancelActiveContentSearch(slot)
      }),
    defaultWorkspaceParent: () => (options.defaultWorkspaceParent ?? defaultParent)(),

    // Writes go to the real path checked and never through a link put there
    // after the check (`writeConfinedFile`).
    async writeText(path, text, roots) {
      await writeConfinedFile(await resolveEditorSaveTarget(path, roots), text)
    },
    saveDroppedImage: (input) => writeAttachmentImageFile(input, 'pasted'),
    async createFile(parentPath, name) {
      const entryName = normalizeEntryName(name)
      await writeConfinedFile(join(await realpath(parentPath), entryName), '', { exclusive: true })
      return join(parentPath, entryName)
    },
    async createDirectory(parentPath, name, existing) {
      const dirPath = join(parentPath, normalizeEntryName(name))
      await mkdir(dirPath, existing === 'keep' ? { recursive: true } : {})
      return dirPath
    },
    async rename(sourcePath, nextName) {
      const name = normalizeEntryName(nextName)
      const targetPath = join(dirname(sourcePath), name)
      if (targetPath === sourcePath) return targetPath
      if (await pathExists(targetPath)) throw new Error(`A file or folder named "${name}" already exists.`)
      await rename(sourcePath, targetPath)
      return targetPath
    },
    async copy(sourcePath, toFolder, onConflict) {
      const sourceName = basename(sourcePath)
      if (onConflict === 'rename') {
        const destinationPath = await getUniqueCopyPath(toFolder, sourceName, sourcePath, pathExists)
        await cp(sourcePath, destinationPath, { errorOnExist: true, force: false, recursive: true })
        return destinationPath
      }
      const destinationPath = join(toFolder, sourceName)
      const overwrite = onConflict === 'overwrite'
      if (!overwrite && (await pathExists(destinationPath)))
        throw new Error(`A file or folder named "${sourceName}" already exists.`)
      await cp(sourcePath, destinationPath, { errorOnExist: !overwrite, force: overwrite, recursive: true })
      return destinationPath
    },
    async move(sourcePath, toFolder) {
      if (isInsideOrEqual(toFolder, sourcePath)) throw new Error('Cannot move a file or folder into itself.')
      const sourceName = basename(sourcePath)
      const destinationPath = join(toFolder, sourceName)
      if (destinationPath === sourcePath) return sourcePath
      if (await pathExists(destinationPath)) throw new Error(`A file or folder named "${sourceName}" already exists.`)
      await rename(sourcePath, destinationPath)
      return destinationPath
    },
    async trash(path) {
      if (!options.trash)
        throw new Error('This Studio cannot reach a Trash on its machine. Remove the file there by hand.')
      await options.trash(path)
    },

    async watch(path, includeIgnored, listener) {
      if (!(await pathExists(path))) return { ok: false, message: 'That folder is not there.' }
      try {
        const subscription = hub.subscribe(path, listener, { includeIgnored })
        return { ok: true, dispose: () => subscription.close() }
      } catch (error) {
        if (isMissingPathError(error)) return { ok: false, message: 'That folder is not there.' }
        throw error
      }
    },
  }
}
