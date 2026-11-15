import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

// The window's worktrees, the real module (every other suite gets its
// stand-in), over a fake window client: each member is the protocol method
// it names, answers as the window's IPC answered, a write carries a command
// id of its own, and the pool's and installs' streams are followed.

type Listener = { onPayload: (payload: unknown) => void }
const fake = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
  subscriptions: [] as Array<{ topic: string; params: unknown; listener: Listener; stopped: boolean }>,
  answer: {} as unknown,
}))

vi.mock('./windowStudioClient', () => {
  const client = {
    supports: () => true,
    subscribe: (topic: string, params: unknown, listener: Listener) => {
      const entry = { topic, params, listener, stopped: false }
      fake.subscriptions.push(entry)
      return () => {
        entry.stopped = true
      }
    },
    request: async (method: string, params: Record<string, unknown>) => {
      fake.requests.push({ method, params })
      return fake.answer
    },
  }
  return {
    windowStudioClient: async () => client,
    windowStudioState: () => 'open',
    watchWindowStudio: () => () => undefined,
    windowHasStudio: () => true,
  }
})

const { worktreesApi } = await vi.importActual<typeof import('./worktrees')>('./worktrees')
const { configureEnvironmentStudio } =
  await vi.importActual<typeof import('./environmentStudio')>('./environmentStudio')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const withoutCommand = (params: Record<string, unknown>) => ({ ...params, commandId: undefined })

const machine = {
  requests: [] as Array<{ route: string; method: string; params: Record<string, unknown> }>,
  answer: (_method: string, _params: Record<string, unknown>): unknown => ({}),
}

beforeEach(() => {
  const host = globalThis as { window?: { api?: object } }
  host.window ??= {}
  const api = { studioWindowTicket: async () => ({}) }
  host.window.api = api
  fake.requests.length = 0
  fake.subscriptions.length = 0
  machine.requests.length = 0
  machine.answer = () => ({})
  // Each machine's own Studio, as the window's client of it reaches it.
  configureEnvironmentStudio(api, {
    connect: async (route) =>
      ({
        state: 'open',
        closed: new Promise(() => undefined),
        close: () => undefined,
        supports: () => true,
        welcome: { environment: { driveMountRoot: '/mnt' } },
        request: async (method: string, params: Record<string, unknown>) => {
          machine.requests.push({ route, method, params })
          return machine.answer(method, params)
        },
      }) as never,
  })
})

test('each member is the method it names, answers as before, and a write carries a command id of its own', async () => {
  fake.answer = { snapshot: null }
  assert.equal(await worktreesApi.getWorktreePoolSnapshot('/Users/dev/app'), null)
  fake.answer = { installs: [] }
  assert.deepEqual(await worktreesApi.listWorktreeInstalls(), [])
  fake.answer = { cancelled: true }
  assert.equal(await worktreesApi.cancelWorktreeInstall('install-1'), true)
  fake.answer = { ok: true, message: null }
  await worktreesApi.worktreePoolAction({ kind: 'release', leaseId: 'lease-1' })
  await worktreesApi.worktreePoolAction({ kind: 'release', leaseId: 'lease-1' })
  fake.answer = { plans: [{ workspaceId: 'ws-1', remoteMachine: null, worktrees: [] }] }
  assert.deepEqual(await worktreesApi.planSettledChatDeletion(['ws-1']), [
    { workspaceId: 'ws-1', remoteMachine: null, worktrees: [] },
  ])
  fake.answer = { outcomes: [{ workspaceId: 'ws-1', ok: true, worktrees: [] }] }
  assert.deepEqual(await worktreesApi.deleteSettledChats(['ws-1']), [{ workspaceId: 'ws-1', ok: true, worktrees: [] }])
  const [snapshot, installs, cancel, first, second, plan, deleted] = fake.requests
  assert.deepEqual(snapshot, { method: 'worktrees.poolSnapshot', params: { repoRoot: '/Users/dev/app' } })
  assert.deepEqual(installs, { method: 'worktrees.installs', params: {} })
  assert.equal(cancel!.method, 'worktrees.cancelInstall')
  assert.deepEqual(withoutCommand(first!.params), {
    action: { kind: 'release', leaseId: 'lease-1' },
    commandId: undefined,
  })
  assert.notEqual(first!.params.commandId, second!.params.commandId, 'two actions are two commands')
  assert.deepEqual(plan, { method: 'settledChats.planDelete', params: { workspaceIds: ['ws-1'] } })
  assert.equal(deleted!.method, 'settledChats.delete')
  assert.equal(typeof deleted!.params.commandId, 'string')
})

test('the agents’ worktree steps send their input whole', async () => {
  fake.answer = { ok: false, message: 'no' }
  const input = {
    repoRoot: '/Users/dev/app',
    containerPath: '/Users/dev/app-worktrees',
    destinationPath: '/Users/dev/app-worktrees/one',
    branchName: 'agent/one',
    baseRef: 'HEAD',
    fromPool: true,
  }
  await worktreesApi.createGitWorktree(input)
  await worktreesApi.restoreGitWorktree({ repoRoot: input.repoRoot, path: input.destinationPath, branchName: 'b' })
  await worktreesApi.removeGitWorktree({ repoRoot: input.repoRoot, path: input.destinationPath, force: true })
  fake.answer = { repoRoot: input.repoRoot, defaultRef: null, entries: [], dryRun: true }
  await worktreesApi.cleanupAgentWorktrees({ repoRoot: input.repoRoot, protectedPaths: [], dryRun: true })
  assert.deepEqual(
    fake.requests.map((request) => [request.method, (request.params.input as { repoRoot: string }).repoRoot]),
    [
      ['worktrees.create', input.repoRoot],
      ['worktrees.restore', input.repoRoot],
      ['worktrees.remove', input.repoRoot],
      ['worktrees.cleanupAgents', input.repoRoot],
    ],
  )
  assert.deepEqual(fake.requests[0]!.params.input, input)
})

test('the pool and the installs are heard on their streams, until the caller stops', async () => {
  const pools: string[] = []
  const stop = worktreesApi.onWorktreePoolChanged((snapshot) => pools.push(snapshot.repoRoot))
  const installs: string[] = []
  worktreesApi.onWorktreeInstallChanged((view) => installs.push(view.id))
  await settle()
  assert.deepEqual(
    fake.subscriptions.map((entry) => entry.topic),
    ['worktrees.poolChanged', 'worktrees.installChanged'],
  )
  fake.subscriptions[0]!.listener.onPayload({ repoRoot: '/Users/dev/app' })
  fake.subscriptions[1]!.listener.onPayload({ id: 'install-1' })
  assert.deepEqual([pools, installs], [['/Users/dev/app'], ['install-1']])
  stop()
  assert.equal(fake.subscriptions[0]!.stopped, true)
})

test('a worktree step on an SSH machine is asked of that machine’s own Studio, its paths as the machine spells them', async () => {
  const app = 'ssh://build-box/home/dev/app'
  machine.answer = (method) =>
    method === 'worktrees.create'
      ? {
          ok: true,
          data: { path: '/home/dev/.sprintengine-worktrees/app/app-01', branch: 'agent/one', leaseId: 'lease-1' },
        }
      : { ok: true, message: null }
  const made = await worktreesApi.createGitWorktree({
    repoRoot: app,
    containerPath: 'ssh://build-box/home/dev/.sprintengine-worktrees/app',
    destinationPath: 'ssh://build-box/home/dev/.sprintengine-worktrees/app/one',
    branchName: 'agent/one',
    baseRef: 'HEAD',
    fromPool: true,
  })
  assert.deepEqual(made, {
    ok: true,
    data: {
      path: 'ssh://build-box/home/dev/.sprintengine-worktrees/app/app-01',
      branch: 'agent/one',
      leaseId: 'lease-1',
    },
  })
  await worktreesApi.removeOtherWorktree({ repoRoot: app, path: `${app}-old` })
  // A lease names no folder: it goes to the machine of the worktree it was handed out for.
  await worktreesApi.worktreePoolAction(
    { kind: 'release', leaseId: 'lease-1', unused: true },
    'ssh://build-box/home/dev/.sprintengine-worktrees/app/app-01',
  )
  await worktreesApi.worktreePoolAction({ kind: 'evict', repoRoot: app, slotId: 'app-01' })
  assert.equal(fake.requests.length, 0, 'nothing of it is asked of this computer’s Studio')
  assert.deepEqual(
    machine.requests.map(({ route, method, params }) => [route, method, { ...params, commandId: undefined }]),
    [
      [
        'ssh:build-box',
        'worktrees.create',
        {
          commandId: undefined,
          input: {
            repoRoot: '/home/dev/app',
            containerPath: '/home/dev/.sprintengine-worktrees/app',
            destinationPath: '/home/dev/.sprintengine-worktrees/app/one',
            branchName: 'agent/one',
            baseRef: 'HEAD',
            fromPool: true,
          },
        },
      ],
      [
        'ssh:build-box',
        'worktrees.removeOther',
        { commandId: undefined, repoRoot: '/home/dev/app', path: '/home/dev/app-old' },
      ],
      [
        'ssh:build-box',
        'worktrees.poolAction',
        { commandId: undefined, action: { kind: 'release', leaseId: 'lease-1', unused: true } },
      ],
      [
        'ssh:build-box',
        'worktrees.poolAction',
        { commandId: undefined, action: { kind: 'evict', repoRoot: '/home/dev/app', slotId: 'app-01' } },
      ],
    ],
  )
  // A lease of this computer's pool stays this computer's.
  fake.answer = { ok: true, message: null }
  await worktreesApi.worktreePoolAction({ kind: 'catch-up', leaseId: 'lease-2' }, '/Users/dev/app-worktrees/app-01')
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['worktrees.poolAction'],
  )
})

test('a step naming folders on two machines is refused in words, nothing asked', async () => {
  await assert.rejects(
    worktreesApi.createGitWorktree({
      repoRoot: 'ssh://build-box/home/dev/app',
      containerPath: '/Users/dev/app-worktrees',
      destinationPath: '/Users/dev/app-worktrees/one',
      branchName: 'agent/one',
      baseRef: 'HEAD',
    }),
    /two machines/u,
  )
  await assert.rejects(
    worktreesApi.worktreePoolAction({ kind: 'evict', repoRoot: '/Users/dev/app', slotId: 'a' }, 'ssh://build-box/x'),
    /two machines/u,
  )
  assert.deepEqual([fake.requests, machine.requests], [[], []])
})

test('a cleanup is asked of its repository’s machine, keeping what the records hold there', async () => {
  fake.answer = { repoRoot: '/Users/dev/app', defaultRef: null, entries: [], dryRun: true }
  machine.answer = () => ({ repoRoot: '/home/dev/app', defaultRef: 'origin/main', entries: [], dryRun: true })
  const protectedPaths = ['/Users/dev/app-worktrees/one', 'ssh://build-box/home/dev/app-w/two', 'ssh://other/x']
  const report = await worktreesApi.cleanupAgentWorktrees({
    repoRoot: 'ssh://build-box/home/dev/app',
    protectedPaths,
    agentIds: ['a1'],
    dryRun: true,
  })
  assert.equal(report.repoRoot, 'ssh://build-box/home/dev/app')
  await worktreesApi.cleanupAgentWorktrees({ repoRoot: '/Users/dev/app', protectedPaths, dryRun: true })
  assert.deepEqual(
    machine.requests.map(({ method, params }) => [method, params.input]),
    [
      [
        'worktrees.cleanupAgents',
        { repoRoot: '/home/dev/app', protectedPaths: ['/home/dev/app-w/two'], agentIds: ['a1'], dryRun: true },
      ],
    ],
  )
  assert.deepEqual(
    fake.requests.map(({ method, params }) => [method, params.input]),
    [
      [
        'worktrees.cleanupAgents',
        { repoRoot: '/Users/dev/app', protectedPaths: ['/Users/dev/app-worktrees/one'], dryRun: true },
      ],
    ],
  )
})

test('the inventory asks each machine for its own projects, and says why one could not be read', async () => {
  fake.answer = {
    projects: [{ repoRoot: '/Users/dev/app', defaultRef: 'origin/main', pool: null, worktrees: [], error: null }],
    measuredAt: 5,
  }
  machine.answer = (_method, params) => {
    if ((params.repoRoots as string[])[0]?.startsWith('/srv')) throw new Error('other-box is not connected.')
    return {
      projects: [{ repoRoot: '/home/dev/app', defaultRef: 'origin/main', pool: null, worktrees: [], error: null }],
      measuredAt: null,
    }
  }
  const inventory = await worktreesApi.getWorktreeInventory({
    repoRoots: ['/Users/dev/app', 'ssh://build-box/home/dev/app', 'ssh://other-box/srv/app'],
  })
  assert.deepEqual(
    inventory.projects.map((project) => [project.repoRoot, project.error]),
    [
      ['/Users/dev/app', null],
      ['ssh://build-box/home/dev/app', null],
      ['ssh://other-box/srv/app', 'other-box is not connected.'],
    ],
  )
  assert.equal(inventory.measuredAt, 5)
  assert.deepEqual(fake.requests[0]?.params, { repoRoots: ['/Users/dev/app'] })
  assert.deepEqual(
    machine.requests.map(({ route, params }) => [route, params.repoRoots]),
    [
      ['ssh:build-box', ['/home/dev/app']],
      ['ssh:other-box', ['/srv/app']],
    ],
  )
})
