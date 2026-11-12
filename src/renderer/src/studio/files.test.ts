import { afterEach, expect, test, vi } from 'vitest'

import { installStudioLoopback } from '../../../../tests/studio-chat-loopback'

// The window's files, the real module (every other suite gets its stand-in),
// over the window's own connection to a Studio: each member is the protocol
// method it names, with what it carries, through the real router.

const { filesApi } = await vi.importActual<typeof import('./files')>('./files')

const host = globalThis as { window?: { api?: Record<string, unknown> } }

afterEach(() => {
  delete host.window
})

function windowWith(stubs: Record<string, unknown>) {
  const win = { api: { ...stubs } }
  host.window = win
  installStudioLoopback(win)
  return win.api
}

test('reads and searches reach the Studio’s files with what the window asked', async () => {
  const api = windowWith({
    readdir: vi.fn(async () => [{ name: 'src', isDir: true }]),
    readfile: vi.fn(async () => '# Notes'),
    pathExists: vi.fn(async () => true),
    statPath: vi.fn(async () => ({ isFile: true, isDirectory: false, sizeBytes: 7, modifiedAt: '', modifiedAtMs: 1 })),
    searchContent: vi.fn(async () => ({
      ok: true,
      results: [],
      truncated: false,
      engine: 'ripgrep',
      elapsedMs: 0,
      resultCount: 0,
    })),
  })
  expect(await filesApi.readdir('/Users/dev/app')).toEqual([{ name: 'src', isDir: true }])
  expect(await filesApi.readfile('/Users/dev/app/notes.md')).toBe('# Notes')
  expect(await filesApi.pathExists('/Users/dev/app/notes.md')).toBe(true)
  expect((await filesApi.statPath('/Users/dev/app/notes.md')).sizeBytes).toBe(7)
  await filesApi.searchContent('/Users/dev/app', 'todo', { limit: 20 })
  expect(api.searchContent).toHaveBeenCalledWith('/Users/dev/app', 'todo', { limit: 20 })
  expect(api.readfile).toHaveBeenCalledWith('/Users/dev/app/notes.md')
})

test('each change carries its own command and what it changes', async () => {
  const api = windowWith({
    writefile: vi.fn(async () => undefined),
    ensureDir: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    createDir: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    copyPath: vi.fn(async () => '/Users/dev/app/sub/a copy.md'),
    copyPathInto: vi.fn(async () => '/Users/dev/app/sub/a.md'),
    deletePath: vi.fn(async () => undefined),
  })
  await filesApi.writefile('/Users/dev/app/a.md', 'text', { roots: ['/Users/dev/app'] })
  expect(api.writefile).toHaveBeenCalledWith('/Users/dev/app/a.md', 'text', { roots: ['/Users/dev/app'] })
  expect(await filesApi.ensureDir('/Users/dev/app', 'backlog')).toBe('/Users/dev/app/backlog')
  expect(api.ensureDir).toHaveBeenCalledTimes(1)
  await filesApi.createDir('/Users/dev/app', 'new')
  expect(api.createDir).toHaveBeenCalledTimes(1)
  await filesApi.copyPath('/Users/dev/app/a.md', '/Users/dev/app/sub')
  await filesApi.copyPathInto('/Users/dev/app/a.md', '/Users/dev/app/sub', { overwrite: true })
  expect(api.copyPathInto).toHaveBeenCalledWith('/Users/dev/app/a.md', '/Users/dev/app/sub', { overwrite: true })
  await filesApi.copyPathInto('/Users/dev/app/a.md', '/Users/dev/app/sub')
  expect(api.copyPathInto).toHaveBeenLastCalledWith('/Users/dev/app/a.md', '/Users/dev/app/sub', { overwrite: false })
  await filesApi.deletePath('/Users/dev/app/a.md')
  expect(api.deletePath).toHaveBeenCalledWith('/Users/dev/app/a.md')
})

test('a failed change is told in the words the Studio said it in, to the app’s own window', async () => {
  windowWith({
    renamePath: vi.fn(async () => {
      throw new Error('A file or folder named "b.md" already exists.')
    }),
  })
  await expect(filesApi.renamePath('/Users/dev/app/a.md', 'b.md')).rejects.toThrow(/already exists/)
})

test('a folder that is not there, or is on an SSH machine, is not watched', async () => {
  const api = windowWith({ pathExists: vi.fn(async () => false) })
  await expect(filesApi.watchPath('/Users/dev/gone', () => undefined)).rejects.toThrow(/Cannot watch missing path/)
  await expect(filesApi.watchPath('ssh://build-box/home/dev/app', () => undefined)).rejects.toThrow(
    /Cannot watch missing path/,
  )
  expect(api.pathExists).toHaveBeenCalledTimes(1)
  api.pathExists = vi.fn(async () => true)
  const stop = await filesApi.watchPath('/Users/dev/app', () => undefined)
  await stop()
})
