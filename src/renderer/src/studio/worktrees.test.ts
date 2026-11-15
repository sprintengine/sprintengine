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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const withoutCommand = (params: Record<string, unknown>) => ({ ...params, commandId: undefined })

beforeEach(() => {
  const host = globalThis as { window?: { api?: unknown } }
  host.window ??= {}
  host.window.api = { studioWindowTicket: async () => ({}) }
  fake.requests.length = 0
  fake.subscriptions.length = 0
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
