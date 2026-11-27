// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const spies = vi.hoisted(() => ({ surface: vi.fn(), external: vi.fn() }))
vi.mock('./openFileSurface', () => ({ openFileSurface: spies.surface }))
vi.mock('../components/auxWindows/openFileWindow', () => ({ openExternalFileWindow: spies.external }))
import { canOpenAnyFile, openAnyFile } from './openAnyFile'

const api = window as unknown as { api?: Record<string, unknown> }
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  delete api.api
})

test('a shell with no open dialog offers nothing and opens nothing', async () => {
  api.api = {}
  expect(canOpenAnyFile()).toBe(false)
  expect(await openAnyFile({ workspaceId: 'workspace' })).toBe(false)
  expect(spies.surface).not.toHaveBeenCalled()
})

test('a cancelled dialog opens nothing', async () => {
  api.api = { openFileDialog: async () => null }
  expect(await openAnyFile({ workspaceId: 'workspace' })).toBe(false)
  expect(spies.surface).not.toHaveBeenCalled()
})

test('a file outside the workspace opens where every file opens, for the workspace in front', async () => {
  const dialog = vi.fn(async () => '/Users/dev/notes/plan.md')
  api.api = { openFileDialog: dialog }
  expect(await openAnyFile({ workspaceId: 'workspace', defaultPath: '/Users/dev/repo' })).toBe(true)
  expect(dialog).toHaveBeenCalledWith({ defaultPath: '/Users/dev/repo' })
  expect(spies.surface).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    path: '/Users/dev/notes/plan.md',
    name: 'plan.md',
  })
})

test('with no workspace in front, the file opens in the editor window', async () => {
  api.api = { openFileDialog: async () => '/Users/dev/notes/plan.md' }
  expect(await openAnyFile({ workspaceId: '' })).toBe(true)
  expect(spies.external).toHaveBeenCalledWith({ workspaceId: '', path: '/Users/dev/notes/plan.md', name: 'plan.md' })
  expect(spies.surface).not.toHaveBeenCalled()
})
