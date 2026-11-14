// The desktop's side of git, the home and git-directory watches on a WSL
// distribution: asked of its Studio over the owner connection, with a watch
// of a folder alone hearing only its own entries.

import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'
import { createWslMachineAccess } from './wsl-machine-client'

type Listener = {
  onPayload(event: { eventType: string; path: string | null; paths?: string[]; overflow?: boolean }): void
  onEnd?(): void
}

function fakeOwner(
  requests: Array<{ method: string; params: unknown }>,
  subscriptions: Array<{ topic: string; params: unknown; listener: Listener; ended: boolean; owner: unknown }>,
) {
  const owner = {
    state: 'open' as 'open' | 'closed',
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      return method === 'environment.home'
        ? { home: '/home/dev', env: {} }
        : { code: 0, stdout: '', stderr: '', timedOut: false }
    },
    subscribe: (topic: string, params: unknown, listener: Listener) => {
      const entry = { topic, params, listener, ended: false, owner }
      subscriptions.push(entry)
      return () => void (entry.ended = true)
    },
  }
  return owner
}

function fakeManager() {
  const requests: Array<{ method: string; params: unknown }> = []
  const subscriptions: Array<{ topic: string; params: unknown; listener: Listener; ended: boolean; owner: unknown }> =
    []
  let current: ReturnType<typeof fakeOwner> | null = fakeOwner(requests, subscriptions)
  const manager = {
    connect: async () => {
      current ??= fakeOwner(requests, subscriptions)
      return { owner: current } as unknown as WslServerConnection
    },
    current: () => (current ? ({ owner: current } as unknown as WslServerConnection) : null),
  } as Pick<WslEnvironmentManager, 'connect' | 'current'>
  return {
    manager,
    requests,
    subscriptions,
    /** The owner connection closes; the server is gone until `serverBack`. */
    connectionLost() {
      if (current) current.state = 'closed'
      current = null
    },
    serverBack() {
      current = fakeOwner(requests, subscriptions)
    },
  }
}

test("git and the home are the distribution's Studio's, over the owner connection", async () => {
  const fake = fakeManager()
  const access = createWslMachineAccess(
    () => fake.manager,
    (distro) => new Error(`no ${distro}`),
  )
  await access.git('Ubuntu', { cwd: '/home/dev/repo', args: ['status'], timeoutMs: 1_000 })
  assert.deepEqual(await access.home('Ubuntu'), { home: '/home/dev', env: {} })
  await access.run('Ubuntu', { argv: ['gh', '--version'], timeoutMs: 1_000 })
  await access.detectClis('Ubuntu', [{ binary: 'claude' }], false).catch(() => undefined)
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['environment.git', 'environment.home', 'environment.run', 'environment.detectClis'],
  )
  assert.deepEqual(fake.requests[3].params, { requests: [{ binary: 'claude' }] }, 'force only when asked')
  const none = createWslMachineAccess(
    () => null,
    (distro) => new Error(`no server for ${distro}`),
  )
  await assert.rejects(none.home('Ubuntu'), /no server for Ubuntu/u)
})

test('a watch follows files.watchPath with nothing left out, and a folder alone hears only its entries', async () => {
  const fake = fakeManager()
  const access = createWslMachineAccess(
    () => fake.manager,
    (distro) => new Error(distro),
  )
  const heard: Array<string | null> = []
  let errors = 0
  const watch = access.watchPath!(
    'Ubuntu',
    '/home/dev/repo/.git',
    false,
    (name) => heard.push(name),
    () => (errors += 1),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const [sub] = fake.subscriptions
  assert.deepEqual(sub.params, { path: '/home/dev/repo/.git', includeIgnored: true })
  sub.listener.onPayload({ eventType: 'change', path: 'HEAD', paths: ['HEAD', 'objects/ab/cdef', 'index'] })
  sub.listener.onPayload({ eventType: 'rename', path: null, overflow: true })
  assert.deepEqual(heard, ['HEAD', 'index', null])
  sub.listener.onEnd?.()
  sub.listener.onEnd?.()
  assert.equal(errors, 1, 'said once')
  watch.close()

  const deep: Array<string | null> = []
  access.watchPath!(
    'Ubuntu',
    '/home/dev/repo/.git/refs',
    true,
    (name) => deep.push(name),
    () => undefined,
  ).close()
  const closedBefore = fake.subscriptions.length
  const live = access.watchPath!(
    'Ubuntu',
    '/home/dev/repo/.git/refs',
    true,
    (name) => deep.push(name),
    () => undefined,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.subscriptions.length, closedBefore + 1, 'one closed before it connected never subscribes')
  fake.subscriptions.at(-1)!.listener.onPayload({ eventType: 'change', path: 'heads/main', paths: ['heads/main'] })
  assert.deepEqual(deep, ['heads/main'])
  live.close()
  assert.equal(fake.subscriptions.at(-1)!.ended, true)
})

test('a watch whose connection went is placed again on the next one, without starting a server for it', async () => {
  vi.useFakeTimers()
  try {
    const fake = fakeManager()
    let connects = 0
    const connect = fake.manager.connect
    fake.manager.connect = (distro) => {
      connects += 1
      return connect(distro)
    }
    const access = createWslMachineAccess(
      () => fake.manager,
      (distro) => new Error(distro),
    )
    const heard: Array<string | null> = []
    let errors = 0
    const watch = access.watchPath!(
      'Ubuntu',
      '/home/dev/repo/.git',
      false,
      (name) => heard.push(name),
      () => (errors += 1),
    )
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(fake.subscriptions.length, 1)
    // The server stopped for being idle: its owner connection closed, and the push ended with it.
    fake.connectionLost()
    fake.subscriptions[0].listener.onEnd?.()
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(errors, 0, 'a lost connection is not a dead watch')
    assert.equal(connects, 1, 'no server is started for a watch')
    assert.equal(fake.subscriptions.length, 1)
    // Something else started it again: the watch is placed there, and says something changed.
    fake.serverBack()
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(fake.subscriptions.length, 2)
    assert.deepEqual(fake.subscriptions[1].params, { path: '/home/dev/repo/.git', includeIgnored: true })
    assert.deepEqual(heard, [null])
    fake.subscriptions[1].listener.onPayload({ eventType: 'change', path: 'HEAD', paths: ['HEAD'] })
    assert.deepEqual(heard, [null, 'HEAD'])
    watch.close()
    assert.equal(fake.subscriptions[1].ended, true)

    // Closed while waiting for the server: never placed again.
    const waiting = access.watchPath!(
      'Ubuntu',
      '/home/dev/repo/.git/refs',
      true,
      () => undefined,
      () => (errors += 1),
    )
    await vi.advanceTimersByTimeAsync(0)
    fake.connectionLost()
    fake.subscriptions.at(-1)!.listener.onEnd?.()
    waiting.close()
    fake.serverBack()
    const placed = fake.subscriptions.length
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(fake.subscriptions.length, placed)
    assert.equal(errors, 0)
  } finally {
    vi.useRealTimers()
  }
})
