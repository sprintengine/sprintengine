import assert from 'node:assert/strict'

import { test } from 'vitest'

import { shellContainersDomain } from '../../../server/desktop/shell-containers'
import type { ControlRpc } from '../../../server/bootstrap/control-rpc'
import { answerContainersCall, createContainersDomain, serveContainersToServer } from './containers-domain'

// The containers as main serves them to the desktop's Studio: in process the
// domain itself, out of process each call over the control channel, checked
// again here by the protocol's own reader, and each change told back.

const SAVED_ID = '0123456789abcdef'
const READY = { state: 'ready' as const, words: 'Docker is running on this Mac.', imageReady: true, canStart: null }

function fakeChats() {
  const done: Array<[string, unknown]> = []
  return {
    done,
    containers: {
      status: async (host: unknown) => (done.push(['status', host]), READY),
      startDocker: async (host: unknown) => (done.push(['startDocker', host]), READY),
      create: async (request: unknown) => (
        done.push(['create', request]),
        { ok: true as const, id: SAVED_ID, label: 'Fix it', folder: '/home/node/work/proj' }
      ),
      list: async () => (done.push(['list', null]), []),
      push: async (id: string) => (done.push(['push', id]), { ok: true as const }),
      remove: async (target: unknown) => (done.push(['remove', target]), { ok: true as const }),
    },
  }
}

function tokenStore() {
  let kept: string | null = null
  return {
    status: async () => ({ set: kept !== null, kept: kept ? ('sealed' as const) : null }),
    set: async (token: string) => ((kept = token), { ok: true as const }),
    clear: async () => void (kept = null),
  }
}

/** Two ends of a control channel in one process: the server's calls reach main's handlers. */
function channel() {
  const handlers = new Map<string, (params: unknown) => unknown>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const rpc: Pick<ControlRpc, 'handle' | 'emit' | 'call' | 'on'> = {
    handle: (method, handler) => (handlers.set(method, handler), () => handlers.delete(method)),
    emit: (name, payload) => listeners.get(name)?.forEach((listener) => listener(payload)),
    call: async <T>(method: string, params?: unknown) => (await handlers.get(method)!(params)) as T,
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
  }
  return rpc
}

test('a token set or forgotten restarts the container servers here; a refused one does not', async () => {
  let restarts = 0
  const store = tokenStore()
  const domain = createContainersDomain({
    containers: fakeChats().containers,
    token: { ...store, set: async (token) => (token === 'bad' ? { ok: false, message: 'Not a token.' } : store.set(token)) },
    onTokenChanged: () => void restarts++,
  })
  assert.deepEqual(await domain.setToken('bad'), { ok: false, message: 'Not a token.' })
  assert.equal(restarts, 0)
  assert.deepEqual(await domain.setToken('sk-ant-oat01-x'), { ok: true })
  assert.deepEqual(await domain.tokenStatus(), { set: true, kept: 'sealed' })
  assert.deepEqual(await domain.clearToken(), { ok: true })
  assert.equal(restarts, 2)
})

test('a server out of process reaches every call through main, and hears each change', async () => {
  const chats = fakeChats()
  const main = createContainersDomain({ containers: chats.containers, token: tokenStore(), onTokenChanged: () => undefined })
  const rpc = channel()
  serveContainersToServer(rpc, main)
  const server = shellContainersDomain(rpc)
  let heard = 0
  server.onChanged(() => void heard++)
  assert.deepEqual(await server.status({ kind: 'ssh', machine: 'build-box' }), READY)
  assert.deepEqual(await server.create({ host: { kind: 'local' }, folder: '/Users/dev/proj', label: 'Fix it', image: { kind: 'studio-default' } }), {
    ok: true,
    id: SAVED_ID,
    label: 'Fix it',
    folder: '/home/node/work/proj',
  })
  assert.deepEqual(await server.push(SAVED_ID), { ok: true })
  assert.deepEqual(
    await server.remove({ host: { kind: 'local' }, name: `sprintengine-${SAVED_ID}`, context: null }),
    { ok: true },
  )
  assert.deepEqual(await server.setToken('sk-ant-oat01-x'), { ok: true })
  assert.deepEqual(await server.tokenStatus(), { set: true, kept: 'sealed' })
  main.changed()
  assert.equal(heard, 1)
  assert.deepEqual(
    chats.done.map(([name]) => name),
    ['status', 'create', 'push', 'remove'],
  )
  assert.deepEqual(chats.done[3]![1], { host: { kind: 'local' }, name: `sprintengine-${SAVED_ID}`, context: null })
})

test('main checks every call again: an unknown call, or args the protocol would refuse, reach nothing', async () => {
  const chats = fakeChats()
  const main = createContainersDomain({ containers: chats.containers, token: tokenStore(), onTokenChanged: () => undefined })
  for (const payload of [
    null,
    { call: 'changed' },
    { call: 'constructor' },
    { call: 'status', args: { host: { kind: 'wsl' } } },
    { call: 'push', args: { id: '../../etc' } },
    { call: 'remove', args: { host: { kind: 'local' }, name: 'postgres' } },
    { call: 'create', args: { host: { kind: 'local' }, folder: 'a\0b' } },
  ])
    await assert.rejects(answerContainersCall(main, payload), Error, JSON.stringify(payload))
  assert.deepEqual(chats.done, [])
})
