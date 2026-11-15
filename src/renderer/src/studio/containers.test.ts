import { afterEach, expect, test, vi } from 'vitest'

// Chats' containers, the real module (every other suite gets its stand-in):
// each call on the window's own Studio, every mutation under a command id of
// its own, and a Studio that makes none said so in words.

const windowStudio = { supports: vi.fn(() => true), request: vi.fn() }

vi.mock('./windowStudioClient', () => ({ windowStudioClient: async () => windowStudio }))

const { containersApi } = await vi.importActual<typeof import('./containers')>('./containers')

afterEach(() => {
  vi.clearAllMocks()
  windowStudio.supports.mockImplementation(() => true)
})

const HOST = { kind: 'local' } as const
const SAVED_ID = '0123456789abcdef'

test('each call is the protocol method of its name, a mutation with a command id of its own', async () => {
  windowStudio.request.mockImplementation(async (method: string) =>
    method === 'containers.list' ? { containers: [] } : { ok: true },
  )
  await containersApi.containerDockerStatus(HOST)
  await containersApi.containerCreate({ host: HOST, folder: '/Users/dev/proj', label: 'Fix', image: { kind: 'studio-default' } })
  expect(await containersApi.containersList()).toEqual([])
  await containersApi.containerPush(SAVED_ID)
  await containersApi.containerRemove({ id: SAVED_ID })
  await containersApi.containerRemove({ host: HOST, name: `sprintengine-${SAVED_ID}` })
  await containersApi.containerTokenSet('sk-ant-oat01-x')
  const calls = windowStudio.request.mock.calls as Array<[string, Record<string, unknown>]>
  expect(calls.map(([method]) => method)).toEqual([
    'containers.status',
    'containers.create',
    'containers.list',
    'containers.push',
    'containers.remove',
    'containers.remove',
    'containers.setToken',
  ])
  expect(calls[0]![1]).toEqual({ host: HOST })
  expect(calls[1]![1]).toMatchObject({ host: HOST, folder: '/Users/dev/proj', label: 'Fix' })
  // One Docker has with no record here: its host's default context, said as null.
  expect(calls[5]![1]).toMatchObject({ host: HOST, name: `sprintengine-${SAVED_ID}`, context: null })
  const ids = calls.filter(([method]) => method !== 'containers.status' && method !== 'containers.list')
  for (const [method, params] of ids) expect(typeof params.commandId, method).toBe('string')
  expect(new Set(ids.map(([, params]) => params.commandId)).size).toBe(ids.length)
})

test('a Studio that makes no containers says so, and nothing is asked', async () => {
  windowStudio.supports.mockImplementation(() => false)
  await expect(containersApi.containersList()).rejects.toThrow(/does not make containers/u)
  expect(windowStudio.request).not.toHaveBeenCalled()
})
