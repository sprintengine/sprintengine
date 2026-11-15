import assert from 'node:assert/strict'
import { test } from 'vitest'

import { watchContainerChats } from './container-chat-lifecycle'

function harness(initial: Array<{ id: string; environment?: { kind: string; id: string } | null }>) {
  let workspaces = initial
  const listeners = new Set<(event: { type: string }) => void>()
  const removed: string[] = []
  let containers = ['c1', 'c2']
  const stop = watchContainerChats({
    workspaces: () => workspaces,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    containerIds: () => containers,
    remove: async (id) => {
      removed.push(id)
      containers = containers.filter((each) => each !== id)
      return { ok: true }
    },
  })
  return {
    removed,
    set(next: typeof workspaces) {
      workspaces = next
      for (const listener of listeners) listener({ type: 'workspace.removed' })
    },
    stop,
  }
}

test("a deleted chat's container is removed with it", async () => {
  const h = harness([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w2', environment: { kind: 'ssh', id: 'c2' } },
  ])
  h.set([{ id: 'w2', environment: { kind: 'ssh', id: 'c2' } }])
  await Promise.resolve()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})

test('a container whose chat has not started yet is not taken by another deletion', async () => {
  // c2 was just made: no chat is on it yet.
  const h = harness([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }, { id: 'w3' }])
  h.set([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }])
  await Promise.resolve()
  assert.deepEqual(h.removed, [])
  // Its chat starts, then is deleted: now it goes.
  h.set([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w4', environment: { kind: 'ssh', id: 'c2' } },
  ])
  h.set([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }])
  await Promise.resolve()
  assert.deepEqual(h.removed, ['c2'])
  h.stop()
})

test('two chats on one container: it stays until the last is deleted', async () => {
  const h = harness([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w2', environment: { kind: 'ssh', id: 'c1' } },
  ])
  h.set([{ id: 'w2', environment: { kind: 'ssh', id: 'c1' } }])
  await Promise.resolve()
  assert.deepEqual(h.removed, [])
  h.set([])
  await Promise.resolve()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})
