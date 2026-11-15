import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { STUDIO_DEFAULT_READ_TIMEOUT_MS } from '../../../../packages/client-runtime/src/public'
import { CONTAINER_CALL_TIMEOUT_MS, shellContainersDomain } from '../../../server/desktop/shell-containers'
import type { ControlRpc } from '../../../server/bootstrap/control-rpc'
import { answerContainersCall, createContainersDomain, serveContainersToServer } from './containers-domain'
import { CONTAINER_COMMAND_INTERRUPTED, ContainerCommandReceipts } from './container-command-receipts'

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
    token: {
      ...store,
      set: async (token) => (token === 'bad' ? { ok: false, message: 'Not a token.' } : store.set(token)),
    },
    receipts: new ContainerCommandReceipts({ path: null }),
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
  const main = createContainersDomain({
    containers: chats.containers,
    token: tokenStore(),
    receipts: new ContainerCommandReceipts({ path: null }),
    onTokenChanged: () => undefined,
  })
  const rpc = channel()
  serveContainersToServer(rpc, main)
  const server = shellContainersDomain(rpc)
  let heard = 0
  server.onChanged(() => void heard++)
  assert.deepEqual(await server.status({ kind: 'ssh', machine: 'build-box' }), READY)
  assert.deepEqual(
    await server.create(
      {
        host: { kind: 'local' },
        folder: '/Users/dev/proj',
        label: 'Fix it',
        image: { kind: 'studio-default' },
      },
      'owner:c1',
    ),
    {
      ok: true,
      id: SAVED_ID,
      label: 'Fix it',
      folder: '/home/node/work/proj',
    },
  )
  assert.deepEqual(await server.push(SAVED_ID, 'owner:c2'), { ok: true })
  assert.deepEqual(
    await server.remove({ host: { kind: 'local' }, name: `sprintengine-${SAVED_ID}`, context: null }, 'owner:c3'),
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
  const main = createContainersDomain({
    containers: chats.containers,
    token: tokenStore(),
    receipts: new ContainerCommandReceipts({ path: null }),
    onTokenChanged: () => undefined,
  })
  for (const payload of [
    null,
    { call: 'changed' },
    { call: 'constructor' },
    { call: 'status', args: { host: { kind: 'wsl' } } },
    { call: 'push', args: { id: '../../etc' } },
    { call: 'remove', args: { host: { kind: 'local' }, name: 'postgres' } },
    { call: 'create', args: { commandId: 'owner:c', host: { kind: 'local' }, folder: 'a\0b' } },
    // A change with no command id could not be carried out only once.
    { call: 'push', args: { id: SAVED_ID } },
    { call: 'create', args: { host: { kind: 'local' }, folder: '/Users/dev/proj' } },
  ])
    await assert.rejects(answerContainersCall(main, payload), Error, JSON.stringify(payload))
  assert.deepEqual(chats.done, [])
})

const REQUEST = {
  host: { kind: 'local' as const },
  folder: '/Users/dev/proj',
  label: 'Fix it',
  image: { kind: 'studio-default' as const },
}

test('a create sent again under its id while it runs, or after, is the first one: one container', async () => {
  const chats = fakeChats()
  let finish: () => void = () => undefined
  const held = new Promise<void>((resolve) => (finish = resolve))
  const create = chats.containers.create
  chats.containers.create = async (request: unknown) => (await held, create(request))
  const main = createContainersDomain({
    containers: chats.containers,
    token: tokenStore(),
    receipts: new ContainerCommandReceipts({ path: null }),
    onTokenChanged: () => undefined,
  })
  // The server restarted mid-build and the client sent it again: the same id.
  const first = main.create(REQUEST, 'owner:k1')
  const again = main.create(REQUEST, 'owner:k1')
  finish()
  assert.deepEqual(await again, await first)
  // Long after, past any server's own memory of answers.
  assert.deepEqual(await main.create(REQUEST, 'owner:k1'), await first)
  assert.equal(chats.done.filter(([name]) => name === 'create').length, 1)
  // Another id is another container; the same id for another request is refused in words.
  await main.create(REQUEST, 'owner:k2')
  assert.equal(chats.done.filter(([name]) => name === 'create').length, 2)
  const conflict = await main.create({ ...REQUEST, label: 'Something else' }, 'owner:k1')
  assert.equal(conflict.ok, false)
  assert.equal(chats.done.filter(([name]) => name === 'create').length, 2)
})

test('what each command did is kept on disk: answered after Studio restarts, and one cut short is never redone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'container-receipts-'))
  try {
    const path = join(dir, 'container-commands.json')
    const chats = fakeChats()
    const before = new ContainerCommandReceipts({ path })
    const main = createContainersDomain({
      containers: chats.containers,
      token: tokenStore(),
      receipts: before,
      onTokenChanged: () => undefined,
    })
    const made = await main.create(REQUEST, 'owner:k1')
    // One still running when Studio stopped: its receipt has no answer yet.
    void before.run('owner:k9', 'fingerprint', () => new Promise(() => undefined))
    const after = createContainersDomain({
      containers: chats.containers,
      token: tokenStore(),
      receipts: new ContainerCommandReceipts({ path }),
      onTokenChanged: () => undefined,
    })
    assert.deepEqual(await after.create(REQUEST, 'owner:k1'), made)
    assert.equal(chats.done.filter(([name]) => name === 'create').length, 1)
    const reloaded = new ContainerCommandReceipts({ path })
    assert.deepEqual(
      await reloaded.run('owner:k9', 'fingerprint', async () => ({ ok: true })),
      CONTAINER_COMMAND_INTERRUPTED,
    )
    assert.match(CONTAINER_COMMAND_INTERRUPTED.message, /Settings › Machines › Containers/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a command that threw, rather than answered, may be tried again', async () => {
  const receipts = new ContainerCommandReceipts({ path: null })
  await assert.rejects(receipts.run('owner:k1', 'f', async () => Promise.reject(new Error('gone'))))
  assert.deepEqual(await receipts.run('owner:k1', 'f', async () => ({ ok: true })), { ok: true })
})

test('a read gets its answer, or this side’s words, before the client gives up on it', () => {
  // Main's probes are bounded at 30 s; the server waits on them under the
  // client's read timeout, so a slow host is said as "Docker did not answer
  // in time", not the client's bare "did not answer".
  for (const read of ['status', 'list', 'tokenStatus'] as const)
    assert.ok(CONTAINER_CALL_TIMEOUT_MS[read] < STUDIO_DEFAULT_READ_TIMEOUT_MS, read)
})
