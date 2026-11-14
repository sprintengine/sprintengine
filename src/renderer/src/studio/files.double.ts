import type * as Files from './files'

// A stand-in for the window's files (`files.ts`), for tests of what calls
// them. Every suite gets it (`tests/setup.ts` mocks the module with this one);
// the module's own test asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `filesDouble`'s, which a suite may set too. Unset, a call
// answers as an empty disk would.

type Api = Files.FilesApi

function blank(): Api {
  const missing = (path: string) => Promise.reject(new Error(`ENOENT: no such file or directory, '${path}'`))
  return {
    readdir: async () => [],
    searchFiles: async () => ({
      ok: true,
      results: [],
      truncated: false,
      engine: 'walker',
      elapsedMs: 0,
      resultCount: 0,
    }),
    searchContent: async () => ({
      ok: true,
      results: [],
      truncated: false,
      engine: 'ripgrep',
      elapsedMs: 0,
      resultCount: 0,
    }),
    cancelContentSearch: async () => undefined,
    cancelFileSearch: async () => undefined,
    readfile: (path) => missing(path),
    readImageDataUrl: (path) => missing(path),
    pathExists: async () => false,
    statPath: (path) => missing(path),
    checkWorkspaceFolder: async (path) => ({
      ok: false,
      status: 'missing',
      path,
      checkedPath: path,
      message: 'Nothing is there.',
    }),
    detectProjectLogo: async () => null,
    readProjectIconFile: async () => null,
    writefile: async () => undefined,
    saveDroppedImage: async () => '/tmp/pasted.png',
    createFile: async (parent, name) => `${parent}/${name}`,
    createDir: async (parent, name) => `${parent}/${name}`,
    ensureDir: async (parent, name) => `${parent}/${name}`,
    renamePath: async (path, name) => `${path.slice(0, path.lastIndexOf('/'))}/${name}`,
    movePath: async (path, folder) => `${folder}/${path.slice(path.lastIndexOf('/') + 1)}`,
    copyPath: async (path, folder) => `${folder}/${path.slice(path.lastIndexOf('/') + 1)}`,
    copyPathInto: async (path, folder) => `${folder}/${path.slice(path.lastIndexOf('/') + 1)}`,
    deletePath: async () => undefined,
    watchPath: async () => async () => undefined,
    defaultWorkspaceParentDir: async () => null,
  }
}

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const filesDouble: Api = blank()

/** Put every member back as it was. */
export function resetFilesDouble(): void {
  Object.assign(filesDouble, blank())
}

export { windowHasStudio } from './windowStudioClient'

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const filesApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (filesDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
