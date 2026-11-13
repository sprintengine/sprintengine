import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

// The window's git, the real module (every other suite gets its stand-in),
// over a fake window client: each member is the protocol method it names, a
// write carries a command id of its own, and a checkout is followed by one
// stream however many views follow it.

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

const { gitApi } = await vi.importActual<typeof import('./git')>('./git')
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  const host = globalThis as { window?: { api?: unknown } }
  host.window ??= {}
  host.window.api = { studioWindowTicket: async () => ({}) }
  fake.requests.length = 0
  fake.subscriptions.length = 0
})

test('each member is the method it names, and a write carries a command id of its own', async () => {
  fake.answer = { paths: ['dist'] }
  assert.deepEqual(await gitApi.checkIgnored('/Users/dev/app', ['dist']), ['dist'])
  fake.answer = { ok: true, stdout: '', stderr: '', message: null }
  await gitApi.commitGitChanges('/Users/dev/app', 'first')
  await gitApi.commitGitChanges('/Users/dev/app', 'first')
  await gitApi.resetGitBranchToCommit('/Users/dev/app', 'abc123', 'hard')
  fake.answer = { repoRoot: '/Users/dev/app' }
  assert.equal(await gitApi.getGitRepoRoot('/Users/dev/app/src'), '/Users/dev/app')
  const [ignored, first, second, reset, root] = fake.requests
  assert.deepEqual(ignored, { method: 'git.checkIgnored', params: { repoRoot: '/Users/dev/app', paths: ['dist'] } })
  assert.equal(first!.method, 'git.commit')
  assert.notEqual(first!.params.commandId, second!.params.commandId, 'two commits are two commands')
  assert.equal(reset!.method, 'git.resetToCommit')
  assert.deepEqual(
    { ...reset!.params, commandId: undefined },
    {
      repoRoot: '/Users/dev/app',
      commit: 'abc123',
      mode: 'hard',
      commandId: undefined,
    },
  )
  assert.deepEqual(root, { method: 'files.repoRoot', params: { folderPath: '/Users/dev/app/src' } })
})

test('a checkout is one stream however many views follow it, ended when the last one stops', async () => {
  const heard: string[] = []
  const stopA = gitApi.watchGitCheckout('/Users/dev/app/', (change) => heard.push(`a:${change.checkoutKey}`))
  const stopB = gitApi.watchGitCheckout('/Users/dev/app', (change) => heard.push(`b:${change.checkoutKey}`))
  await settle()
  assert.equal(fake.subscriptions.length, 1)
  assert.deepEqual(fake.subscriptions[0]!.params, { checkoutPath: '/Users/dev/app' })
  fake.subscriptions[0]!.listener.onPayload({ checkoutKey: '/Users/dev/app', kinds: ['refs'] })
  assert.deepEqual(heard, ['a:/Users/dev/app', 'b:/Users/dev/app'])
  stopA()
  assert.equal(fake.subscriptions[0]!.stopped, false)
  stopB()
  assert.equal(fake.subscriptions[0]!.stopped, true)
})
