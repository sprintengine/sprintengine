import { afterEach, expect, test, vi } from 'vitest'

// The machines this computer offers, the real module (every other suite gets
// its stand-in): the list on the window's own Studio, and a distribution's
// home asked of that distribution's own Studio and spelled as Windows opens it.

const windowStudio = { supports: vi.fn(() => true), request: vi.fn() }
const distroStudio = {
  supports: vi.fn(() => true),
  request: vi.fn(),
  welcome: { environment: { driveMountRoot: '/mnt/' as string | null } },
}
const asked: Array<{ route: string; name: string }> = []

vi.mock('./windowStudioClient', () => ({ windowStudioClient: async () => windowStudio }))
vi.mock('./environmentStudio', () => ({
  withEnvironmentStudio: async (target: { route: string; name: string }, work: (client: unknown) => unknown) => {
    asked.push(target)
    return work(distroStudio)
  },
}))

const { hostsApi } = await vi.importActual<typeof import('./hosts')>('./hosts')

afterEach(() => {
  vi.clearAllMocks()
  asked.length = 0
  windowStudio.supports.mockImplementation(() => true)
})

test('the list is asked of the window’s Studio with only the flags given', async () => {
  windowStudio.request.mockResolvedValue({ hosts: [], wsl: null })
  await hostsApi.hostsList({ all: true })
  await hostsApi.hostsList()
  expect(windowStudio.request.mock.calls).toEqual([
    ['hosts.list', { all: true }],
    ['hosts.list', {}],
  ])
  windowStudio.supports.mockImplementation(() => false)
  await expect(hostsApi.hostsList()).rejects.toThrow(/does not list/u)
})

test('a distribution’s home is its own Studio’s word, spelled as its share', async () => {
  distroStudio.request.mockResolvedValue({ path: '/home/dev/Documents' })
  expect(await hostsApi.hostsHome('wsl:Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\Documents')
  expect(asked).toEqual([{ route: 'wsl:Ubuntu', name: 'WSL: Ubuntu' }])
  expect(distroStudio.request).toHaveBeenCalledWith('files.defaultWorkspaceParent', {})
  // No answer there is no home; this computer has none to ask for.
  distroStudio.request.mockResolvedValue({ path: null })
  expect(await hostsApi.hostsHome('wsl:Ubuntu')).toBeNull()
  expect(await hostsApi.hostsHome('local')).toBeNull()
  expect(asked).toHaveLength(2)
})
