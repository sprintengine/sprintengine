// The desktop's side of git, the home and git-directory watches on a WSL
// distribution: asked of its Studio over the owner connection, with a watch
// of a folder alone hearing only its own entries.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'
import { createWslMachineAccess } from './wsl-machine-client'

type Listener = {
  onPayload(event: { eventType: string; path: string | null; paths?: string[]; overflow?: boolean }): void
  onEnd?(): void
}

function fakeManager() {
  const requests: Array<{ method: string; params: unknown }> = []
  const subscriptions: Array<{ topic: string; params: unknown; listener: Listener; ended: boolean }> = []
  const owner = {
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      return method === 'environment.home'
        ? { home: '/home/dev', env: {} }
        : { code: 0, stdout: '', stderr: '', timedOut: false }
    },
    subscribe: (topic: string, params: unknown, listener: Listener) => {
      const entry = { topic, params, listener, ended: false }
      subscriptions.push(entry)
      return () => void (entry.ended = true)
    },
  }
  const manager = {
    connect: async () => ({ owner }) as unknown as WslServerConnection,
  } as Pick<WslEnvironmentManager, 'connect'>
  return { manager, requests, subscriptions }
}

test("git and the home are the distribution's Studio's, over the owner connection", async () => {
  const fake = fakeManager()
  const access = createWslMachineAccess(
    () => fake.manager,
    (distro) => new Error(`no ${distro}`),
  )
  await access.git('Ubuntu', { cwd: '/home/dev/repo', args: ['status'], timeoutMs: 1_000 })
  assert.deepEqual(await access.home('Ubuntu'), { home: '/home/dev', env: {} })
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['environment.git', 'environment.home'],
  )
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
