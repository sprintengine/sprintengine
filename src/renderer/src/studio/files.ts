import {
  STUDIO_FILE_SYSTEM_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  type ContentSearchResult,
  type FileWatchEvent,
  type ProjectLogo,
  type StudioCapability,
  type StudioFileSearchResult,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioPathStat,
  type WorkspaceFolderCheckResult,
} from '../../../../packages/studio-protocol/src/public'
import { isMachinePath } from '../../../shared/machine-paths'
import { followWindowStudioPush } from './windowStudioPush'
import { askStudioOfPaths } from './paneStudio'
import { watchWindowStudio, windowStudioState } from './windowStudioClient'

// The window's way to the files on its Studio's machine: the Studio protocol's
// `files.*` methods by path and the `files.watchPath` stream, over the
// window's own connection, as every other client reaches them. A path on an
// SSH machine is asked of that machine's own Studio (`paneStudio.ts`). The Files
// pane, the editor, the diff view, the previews, the palette, the aux windows
// and a new project's checks call these. The members keep the names the
// window has always called them by, so a caller changes only where it
// imports them from.
//
// What stays the shell's own is not here: revealing a file in the system's
// file manager, opening one in another app, and the folder and icon pickers
// (`window.api`).

export type FilesApi = {
  readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>
  searchFiles(
    rootPath: string,
    query: string,
    options?: { limit?: number; purpose?: 'mention'; channel?: string; recentAt?: Record<string, number> },
  ): Promise<StudioFileSearchResult>
  searchContent(rootPath: string, query: string, options?: { limit?: number }): Promise<ContentSearchResult>
  cancelContentSearch(): Promise<void>
  cancelFileSearch(channel?: string): Promise<void>
  readfile(path: string): Promise<string>
  readImageDataUrl(path: string): Promise<string>
  pathExists(path: string): Promise<boolean>
  statPath(path: string): Promise<StudioPathStat>
  checkWorkspaceFolder(path: string): Promise<WorkspaceFolderCheckResult>
  detectProjectLogo(folderPath: string): Promise<ProjectLogo | null>
  readProjectIconFile(filePath: string): Promise<ProjectLogo | null>
  /** `roots` are the folders of the project the file was opened in: a save there does not write through a link out of them. */
  writefile(path: string, content: string, options?: { roots?: readonly string[] }): Promise<void>
  saveDroppedImage(input: { mediaType: string; dataBase64: string }): Promise<string>
  createFile(parentDir: string, name: string): Promise<string>
  createDir(parentDir: string, name: string): Promise<string>
  /** As `createDir`, but a folder already there (and any missing parents) is fine. */
  ensureDir(parentDir: string, name: string): Promise<string>
  renamePath(sourcePath: string, nextName: string): Promise<string>
  movePath(sourcePath: string, destinationDir: string): Promise<string>
  /** A copy beside its name's others (`a copy.txt`) in the destination. */
  copyPath(sourcePath: string, destinationDir: string): Promise<string>
  /** A copy under its own name, refused when it is taken unless `overwrite`. */
  copyPathInto(sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }): Promise<string>
  /** To the Trash of the Studio's machine. */
  deletePath(targetPath: string): Promise<void>
  /** Hear changes under a folder; rejects for one that is not there. Resolves to the unsubscriber. */
  watchPath(
    path: string,
    cb: (event: FileWatchEvent) => void,
    options?: { includeIgnored?: boolean },
  ): Promise<() => Promise<void>>
  defaultWorkspaceParentDir(): Promise<string | null>
}

const UNSERVED = 'This Studio does not serve the files on its machine to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Ask the Studio on the machine the path is on: the window's own, or an SSH machine's (`paneStudio.ts`). */
function call<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
  capability: StudioCapability = STUDIO_FILE_SYSTEM_CAPABILITY,
): Promise<StudioMethodResult<M>> {
  return askStudioOfPaths(method, params, capability, UNSERVED)
}

const mention = STUDIO_FILES_CAPABILITY

export { windowHasStudio } from './windowStudioClient'

export const filesApi: FilesApi = {
  readdir: async (path) => (await call('files.listDirectory', { path })).entries,
  searchFiles: (rootPath, query, options = {}) =>
    call(
      'files.search',
      {
        rootPath,
        query,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        ...(options.channel === undefined ? {} : { channel: options.channel }),
        ...(options.recentAt === undefined ? {} : { recentAt: options.recentAt }),
      },
      mention,
    ),
  searchContent: (rootPath, query, options = {}) =>
    call('files.searchContent', { rootPath, query, ...(options.limit === undefined ? {} : { limit: options.limit }) }),
  cancelContentSearch: async () => {
    await call('files.cancelContentSearch', {})
  },
  cancelFileSearch: async (channel) => {
    await call('files.cancelSearch', channel === undefined ? {} : { channel }, mention)
  },
  readfile: async (path) => (await call('files.readText', { path })).text,
  readImageDataUrl: async (path) => (await call('files.readImage', { path }, mention)).dataUrl,
  pathExists: async (path) => (await call('files.exists', { path })).exists,
  statPath: async (path) => (await call('files.stat', { path }, mention)).stat as StudioPathStat,
  checkWorkspaceFolder: (path) => call('files.checkWorkspaceFolder', { path }),
  detectProjectLogo: async (folderPath) => (await call('files.projectLogo', { folderPath })).logo,
  readProjectIconFile: async (path) => (await call('files.projectIcon', { path })).logo,
  writefile: async (path, text, options = {}) => {
    await call('files.writeText', {
      commandId: randomId(),
      path,
      text,
      ...(options.roots === undefined ? {} : { roots: [...options.roots] }),
    })
  },
  saveDroppedImage: async (input) =>
    (
      await call('files.saveDroppedImage', {
        commandId: randomId(),
        mediaType: input.mediaType,
        dataBase64: input.dataBase64,
      })
    ).path,
  createFile: async (parentPath, name) =>
    (await call('files.createFile', { commandId: randomId(), parentPath, name })).path,
  createDir: async (parentPath, name) =>
    (await call('files.createDirectory', { commandId: randomId(), parentPath, name })).path,
  ensureDir: async (parentPath, name) =>
    (await call('files.createDirectory', { commandId: randomId(), parentPath, name, existing: 'keep' })).path,
  renamePath: async (path, name) => (await call('files.rename', { commandId: randomId(), path, name })).path,
  movePath: async (path, toFolder) => (await call('files.move', { commandId: randomId(), path, toFolder })).path,
  copyPath: async (path, toFolder) =>
    (await call('files.copy', { commandId: randomId(), path, toFolder, onConflict: 'rename' })).path,
  copyPathInto: async (path, toFolder, options = {}) =>
    (
      await call('files.copy', {
        commandId: randomId(),
        path,
        toFolder,
        onConflict: options.overwrite === true ? 'overwrite' : 'fail',
      })
    ).path,
  deletePath: async (path) => {
    await call('files.trash', { commandId: randomId(), path })
  },
  watchPath: async (path, cb, options = {}) => {
    // A folder on an SSH machine is not watched: its views refresh by asking again.
    if (isMachinePath(path) || !(await call('files.exists', { path })).exists)
      throw new Error(`Cannot watch missing path: ${path}`)
    const stop = followWindowStudioPush({
      topic: 'files.watchPath',
      params: { path, ...(options.includeIgnored === true ? { includeIgnored: true } : {}) },
      capability: STUDIO_FILE_SYSTEM_CAPABILITY,
      onPayload: cb,
    })
    // The stream replays nothing: what changed while the window's connection
    // was down is never heard. Back up, the watcher is told to read everything
    // again (`overflow`), as it is for a burst too large to list, so an editor
    // or a tree is not left showing a file as it was.
    const api = typeof window === 'undefined' ? undefined : window.api
    let down = false
    const unwatch = api
      ? watchWindowStudio(api, () => {
          if (windowStudioState(api) !== 'open') down = true
          else if (down) {
            down = false
            cb({ eventType: 'rename', path: null, paths: [], overflow: true })
          }
        })
      : () => undefined
    return async () => {
      unwatch()
      stop()
    }
  },
  defaultWorkspaceParentDir: async () => (await call('files.defaultWorkspaceParent', {})).path,
}
