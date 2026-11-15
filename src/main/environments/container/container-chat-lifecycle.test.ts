import assert from 'node:assert/strict'
import { test } from 'vitest'

import { watchContainerChats } from './container-chat-lifecycle'

type Workspace = { id: string; environment?: { kind: string; id: string } | null }

function harness(
  initial: Workspace[],
  options: {
    containers?: Array<{ id: string; pendingRemoval?: string | null }>
    removeAnswers?: (id: string) => { ok: boolean; message?: string }
  } = {},
) {
  let workspaces = initial
  const listeners = new Set<(event: { type: string }) => void>()
  const removed: string[] = []
  const tried: string[] = []
  const containers = new Map<string, string | null>(
    (options.containers ?? [{ id: 'c1' }, { id: 'c2' }]).map((each) => [each.id, each.pendingRemoval ?? null]),
  )
  const stop = watchContainerChats({
    workspaces: () => workspaces,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    containers: () => [...containers].map(([id, pendingRemoval]) => ({ id, pendingRemoval })),
    remove: async (id) => {
      tried.push(id)
      const answer = options.removeAnswers?.(id) ?? { ok: true }
      if (answer.ok) {
        removed.push(id)
        containers.delete(id)
      }
      return answer
    },
    markPending: (id, why) => {
      if (containers.has(id)) containers.set(id, why)
    },
    retryMs: 60 * 60_000,
  })
  return {
    removed,
    tried,
    pending: (id: string) => containers.get(id),
    set(next: Workspace[]) {
      workspaces = next
      for (const listener of listeners) listener({ type: 'workspace.removed' })
    },
    poke() {
      for (const listener of listeners) listener({ type: 'workspace.renamed' })
    },
    stop,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a deleted chat's container is removed with it", async () => {
  const h = harness([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w2', environment: { kind: 'ssh', id: 'c2' } },
  ])
  h.set([{ id: 'w2', environment: { kind: 'ssh', id: 'c2' } }])
  await flush()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})

test('a container whose chat has not started yet is not taken by another deletion', async () => {
  // c2 was just made: no chat is on it yet.
  const h = harness([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }, { id: 'w3' }])
  h.set([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }])
  await flush()
  assert.deepEqual(h.removed, [])
  // Its chat starts, then is deleted: now it goes.
  h.set([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w4', environment: { kind: 'ssh', id: 'c2' } },
  ])
  h.set([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }])
  await flush()
  assert.deepEqual(h.removed, ['c2'])
  h.stop()
})

test('two chats on one container: it stays until the last is deleted', async () => {
  const h = harness([
    { id: 'w1', environment: { kind: 'ssh', id: 'c1' } },
    { id: 'w2', environment: { kind: 'ssh', id: 'c1' } },
  ])
  h.set([{ id: 'w2', environment: { kind: 'ssh', id: 'c1' } }])
  await flush()
  assert.deepEqual(h.removed, [])
  h.set([])
  await flush()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})

test('a removal that cannot happen now waits, says why, and is tried again until it goes', async () => {
  let dockerUp = false
  const h = harness([{ id: 'w1', environment: { kind: 'ssh', id: 'c1' } }], {
    containers: [{ id: 'c1' }],
    removeAnswers: () =>
      dockerUp ? { ok: true } : { ok: false, message: 'Docker is not running on this Mac, so it is still there.' },
  })
  h.set([])
  await flush()
  assert.deepEqual(h.removed, [])
  assert.equal(h.pending('c1'), 'Docker is not running on this Mac, so it is still there.')
  // Nothing about the chat changes, but the next registry change tries again.
  h.poke()
  await flush()
  assert.deepEqual(h.tried, ['c1', 'c1'])
  dockerUp = true
  h.poke()
  await flush()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})

test('a removal left waiting by an earlier run is tried at start, with no chat ever seen on it here', async () => {
  const h = harness([], { containers: [{ id: 'c1', pendingRemoval: 'The machine was away.' }] })
  await flush()
  assert.deepEqual(h.removed, ['c1'])
  h.stop()
})
