import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioModuleEvent, StudioModuleNotification } from '../../../packages/studio-protocol/src/public'
import { createMainKernel, createServiceToken } from '../../main/module-host/main-host'
import type { ModuleLifecycle } from '../../main/modules/module-lifecycle'
import type { ModuleUsageRegistry } from '../../shared/modules/activity-service'
import type { ModuleBacklogRegistry } from '../../shared/modules/backlog-service'
import type { ModuleMethodParsed } from '../../shared/modules/methods'
import { createStudioModuleHub, type StudioModules } from './studio-modules'
import { createExtensionEvents } from '../extensions/events/extension-events'
import type { FakeAuthenticator } from './studio-rpc.test-helper'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The catalogue is not what these tests are about.
const NO_CATALOGUE = {} as ModuleLifecycle['catalogue']

// `extension.events` and `extension.notifications` over the owner socket: the
// capability, the scope, the module filter, and the bell's kept rows sent
// before the live ones. The hub is the real one; the kernel behind it is not
// here (module-events.test.ts and module-notifications.test.ts hold it).
// `extension.read` and `extension.operate` are called through the hub into a real
// kernel, with a module's declared methods behind it.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function event(sourceModuleId: string, topic: string, payload?: unknown): StudioModuleEvent {
  return { sourceModuleId, topic, emittedAt: 1, ...(payload === undefined ? {} : { payload }) }
}

function row(id: string, title: string): StudioModuleNotification {
  return { id, sourceModuleId: 'acme.board', sourceModuleName: 'Board', severity: 'info', title, emittedAt: 1 }
}

/** The real hub, saying when a connection starts listening. */
function hubWithListening() {
  const hub = createStudioModuleHub()
  const waiting: Array<() => void> = []
  const listening = () => new Promise<void>((resolve) => waiting.push(resolve))
  const heard = () => waiting.splice(0).forEach((resolve) => resolve())
  const watched: StudioModules = {
    ...hub,
    onEvent: (listener) => {
      const stop = hub.onEvent(listener)
      heard()
      return stop
    },
    onNotification: (listener) => {
      const stop = hub.onNotification(listener)
      heard()
      return stop
    },
  }
  return { hub: watched, listening }
}

async function clientOver(
  modules: StudioModules | undefined,
  token?: (started: Awaited<ReturnType<typeof startTestServer>>) => string,
) {
  const started = await startTestServer(modules ? { modules } : {})
  cleanups.push(() => started.dispose())
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: token ? token(started) : OWNER_TOKEN }))
  const welcome = await client.next((frame) => frame.t === 'welcome')
  return { client, welcome }
}

test('a Studio with a module kernel advertises modules, and one without refuses the streams', async () => {
  const { welcome } = await clientOver(createStudioModuleHub())
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('extension-host'), true)
  const without = await clientOver(undefined)
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('extension-host'), false)
  without.client.send({ t: 'sub', id: 's1', topic: 'extension.events', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test("every module's events, or one module's, in the order the kernel delivered them", async () => {
  const { hub, listening } = hubWithListening()
  const { client } = await clientOver(hub)
  const both = listening()
  client.send({ t: 'sub', id: 'all', topic: 'extension.events', params: {} })
  await both
  const one = listening()
  client.send({ t: 'sub', id: 'radar', topic: 'extension.events', params: { moduleId: 'acme.radar' } })
  await one
  hub.deliverEvent(event('acme.board', 'changed', { id: 1 }))
  hub.deliverEvent(event('acme.radar', 'run-status', { phase: 'started' }))
  hub.deliverEvent(event('acme.radar', 'run-status', { phase: 'done' }))
  const all = [] as unknown[]
  const radar = [] as unknown[]
  while (all.length < 3 || radar.length < 2) {
    const frame = await client.next((next) => next.t === 'push')
    if (frame.t !== 'push') continue
    ;(frame.sub === 'all' ? all : radar).push(frame.payload)
  }
  assert.deepEqual(
    all.map((payload) => (payload as StudioModuleEvent).sourceModuleId),
    ['acme.board', 'acme.radar', 'acme.radar'],
  )
  assert.deepEqual(radar, [
    event('acme.radar', 'run-status', { phase: 'started' }),
    event('acme.radar', 'run-status', { phase: 'done' }),
  ])
})

test('a surface’s Studio event is held to its extension’s approval and to the connection’s grant, at each event', async () => {
  const events = createExtensionEvents()
  const grants: Record<string, readonly string[] | null> = { 'acme.board': ['workspace:read'] }
  events.bind({ eventsListed: () => false, deliverEvent: () => undefined, grantOf: (id) => grants[id] ?? null })
  const started = await startTestServer({ modules: createStudioModuleHub(), extensionEvents: events })
  cleanups.push(() => started.dispose())
  const auth: FakeAuthenticator = started.auth
  const connect = async (token: string) => {
    const client = await connectLineClient(started.path)
    cleanups.push(() => client.close())
    client.send(hello({ token }))
    await client.next((frame) => frame.t === 'welcome')
    return client
  }
  const owner = await connect(OWNER_TOKEN)
  owner.send({
    t: 'sub',
    id: 'w',
    topic: 'extension.studioEvents',
    params: { moduleId: 'acme.board', event: 'workspace.created' },
  })
  owner.send({
    t: 'sub',
    id: 'x',
    topic: 'extension.studioEvents',
    params: { moduleId: 'acme.radar', event: 'workspace.created' },
  })
  const unapproved = await owner.next((frame) => frame.t === 'subFailed' && frame.sub === 'x')
  assert.equal(unapproved.t === 'subFailed' && unapproved.code, 'approval_required')
  // A paired device granted extensions but not workspaces is refused what the extension may hear.
  const device = await connect(pairFakeClient(auth, 'build-box', ['extensions:read']))
  device.send({
    t: 'sub',
    id: 'd',
    topic: 'extension.studioEvents',
    params: { moduleId: 'acme.board', event: 'workspace.created' },
  })
  const refused = await device.next((frame) => frame.t === 'subFailed' && frame.sub === 'd')
  assert.equal(refused.t === 'subFailed' && refused.code, 'not_permitted')
  await new Promise((resolve) => setTimeout(resolve, 50))
  events.emit('workspace.created', {
    workspaceId: 'ws-1',
    name: 'Notes',
    kind: 'folder',
    folderPath: null,
    branch: null,
  })
  const heard = await owner.next((frame) => frame.t === 'push' && frame.sub === 'w')
  assert.deepEqual(heard.t === 'push' && heard.payload, {
    event: 'workspace.created',
    payload: { workspaceId: 'ws-1', name: 'Notes', kind: 'folder', folderPath: null, branch: null },
  })
  // Its approval narrowed: the next event is not sent.
  grants['acme.board'] = []
  events.emit('workspace.created', {
    workspaceId: 'ws-2',
    name: 'Site',
    kind: 'folder',
    folderPath: null,
    branch: null,
  })
  const late = await Promise.race([
    owner.next((frame) => frame.t === 'push' && frame.sub === 'w').then(() => 'sent'),
    new Promise((resolve) => setTimeout(() => resolve('held back'), 200)),
  ])
  assert.equal(late, 'held back')
})

test('a malformed module filter is refused', async () => {
  const { client } = await clientOver(createStudioModuleHub())
  client.send({ t: 'sub', id: 's1', topic: 'extension.events', params: { moduleId: 7 } })
  const failed = await client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'invalid_params')
})

test('the bell sends the kept rows first, then each new one, and again on a new subscription', async () => {
  const { hub, listening } = hubWithListening()
  const kept = [row('k1-0', 'Failed to load')]
  hub.readRecentFrom(() => kept)
  const { client } = await clientOver(hub)
  const subscribed = listening()
  client.send({ t: 'sub', id: 'bell', topic: 'extension.notifications', params: {} })
  await subscribed
  kept.push(row('k1-1', 'Standup ready'))
  hub.deliverNotification(row('k1-1', 'Standup ready'))
  const first = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  const second = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  assert.deepEqual(
    [first, second].map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'k1-1'],
  )
  client.send({ t: 'sub', id: 'again', topic: 'extension.notifications', params: {} })
  const resent = [
    await client.next((frame) => frame.t === 'push' && frame.sub === 'again'),
    await client.next((frame) => frame.t === 'push' && frame.sub === 'again'),
  ]
  assert.deepEqual(
    resent.map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'k1-1'],
    'a client that subscribes again (a reconnect) hears the kept rows again; their ids dedupe them',
  )
})

test('a row the Studio raised while no client followed the bell is sent to the next one', async () => {
  const { hub, listening } = hubWithListening()
  hub.readRecentFrom(() => [{ ...row('k1-0', 'Failed to load'), emittedAt: 1 }])
  // A kill found while every window was closed.
  hub.deliverKeptNotification({ ...row('catalogue-1', 'Notes was switched off'), emittedAt: 2 })
  const { client } = await clientOver(hub)
  const subscribed = listening()
  client.send({ t: 'sub', id: 'bell', topic: 'extension.notifications', params: {} })
  await subscribed
  const sent = [
    await client.next((frame) => frame.t === 'push' && frame.sub === 'bell'),
    await client.next((frame) => frame.t === 'push' && frame.sub === 'bell'),
  ]
  assert.deepEqual(
    sent.map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'catalogue-1'],
  )
})

test('a paired client needs extensions:read, and holds it only when granted', async () => {
  const hub = createStudioModuleHub()
  const without = await clientOver(hub, (started) => pairFakeClient(started.auth, 'app', ['conversation:read']))
  without.client.send({ t: 'sub', id: 's1', topic: 'extension.notifications', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')

  const { hub: watched, listening } = hubWithListening()
  const granted = await clientOver(watched, (started) => pairFakeClient(started.auth, 'reader', ['extensions:read']))
  const subscribed = listening()
  granted.client.send({ t: 'sub', id: 's2', topic: 'extension.events', params: {} })
  await subscribed
  watched.deliverEvent(event('acme.board', 'changed'))
  const pushed = await granted.client.next((frame) => frame.t === 'push' && frame.sub === 's2')
  assert.deepEqual(pushed.t === 'push' && pushed.payload, event('acme.board', 'changed'))
})

test('one listener that throws does not keep an event from the others', () => {
  const hub = createStudioModuleHub()
  const heard: string[] = []
  hub.onEvent(() => {
    throw new Error('socket gone')
  })
  hub.onEvent((delivered) => heard.push(delivered.topic))
  hub.deliverEvent(event('acme.board', 'changed'))
  assert.deepEqual(heard, ['changed'])
})

// ── Declared methods ─────────────────────────────────────────────────────────

/** A hub served by a real kernel in which `acme.board` declares a read and an operate. */
function hubWithBoard() {
  const kernel = createMainKernel({
    resolveModuleManifest: (id) =>
      id === 'acme.board'
        ? {
            id,
            displayName: 'Board',
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            permissions: [],
          }
        : undefined,
  })
  const saved: Array<{ title: string; commandId?: string; clientId: string }> = []
  const title = (value: unknown): ModuleMethodParsed<{ title: string }> =>
    typeof (value as { title?: unknown } | undefined)?.title === 'string'
      ? { ok: true, params: { title: (value as { title: string }).title } }
      : { ok: false, message: '"title" is the card\'s title.' }
  kernel.hostFor('acme.board').registerMethods<{
    'cards.list': { access: 'read'; params: Record<string, never>; result: string[] }
    'cards.add': { access: 'operate'; params: { title: string }; result: { count: number }; errors: 'duplicate' }
  }>({
    'cards.list': {
      access: 'read',
      params: () => ({ ok: true, params: {} }),
      handler: () => ({ ok: true, result: saved.map((card) => card.title) }),
    },
    'cards.add': {
      access: 'operate',
      params: title,
      handler: (params, context) => {
        if (params.title === 'taken') return { ok: false, code: 'duplicate', message: 'A card has that title.' }
        saved.push({
          title: params.title,
          clientId: context.clientId,
          ...(context.commandId ? { commandId: context.commandId } : {}),
        })
        return { ok: true, result: { count: saved.length } }
      },
    },
  })
  const hub = createStudioModuleHub()
  hub.serveCallsFrom((request) => kernel.callModuleMethod(request))
  return { hub, saved }
}

async function caller(
  modules: StudioModules,
  token?: (started: Awaited<ReturnType<typeof startTestServer>>) => string,
) {
  const started = await startTestServer({ modules })
  cleanups.push(() => started.dispose())
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: token ? token(started) : OWNER_TOKEN }))
  await client.next((frame) => frame.t === 'welcome')
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = `r${++seq}`
    client.send({ t: 'req', id, method, params })
    return client.next((frame) => frame.t === 'res' && frame.id === id)
  }
  return { started, request }
}

const answerOf = (frame: { t: string; ok?: boolean; result?: unknown }) =>
  frame.t === 'res' && frame.ok ? frame.result : null
const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? frame.error?.code : null

test('a module’s read and operate methods answer over the socket, its own refusals as answers', async () => {
  const { hub, saved } = hubWithBoard()
  const { request } = await caller(hub)
  const added = await request('extension.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'Ship it' },
    commandId: 'c1',
  })
  assert.deepEqual(answerOf(added), { ok: true, result: { count: 1 } })
  assert.deepEqual(saved, [{ title: 'Ship it', clientId: 'owner', commandId: 'owner:c1' }])
  assert.deepEqual(answerOf(await request('extension.read', { moduleId: 'acme.board', method: 'cards.list' })), {
    ok: true,
    result: ['Ship it'],
  })
  const taken = await request('extension.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'taken' },
    commandId: 'c2',
  })
  assert.deepEqual(answerOf(taken), { ok: false, code: 'duplicate', message: 'A card has that title.' })
})

test('the host’s refusals: no such module, no such method, the wrong entry, and params the module refuses', async () => {
  const { hub } = hubWithBoard()
  const { request } = await caller(hub)
  assert.equal(
    codeOf(await request('extension.read', { moduleId: 'acme.gone', method: 'cards.list' })),
    'extension_unavailable',
  )
  assert.equal(
    codeOf(await request('extension.read', { moduleId: 'acme.board', method: 'cards.burn' })),
    'extension_method_unknown',
  )
  assert.equal(
    codeOf(await request('extension.read', { moduleId: 'acme.board', method: 'cards.add' })),
    'extension_method_unknown',
  )
  const refused = await request('extension.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { name: 'x' },
    commandId: 'c1',
  })
  assert.equal(codeOf(refused), 'invalid_params')
  assert.match(refused.t === 'res' && !refused.ok ? refused.error.message : '', /"title"/)
})

test('a retried operate is carried out once; the same id for another call is refused', async () => {
  const { hub, saved } = hubWithBoard()
  const { request } = await caller(hub)
  const params = { moduleId: 'acme.board', method: 'cards.add', params: { title: 'Once' }, commandId: 'c1' }
  const first = await request('extension.operate', params)
  const again = await request('extension.operate', params)
  assert.deepEqual(answerOf(again), answerOf(first))
  assert.equal(saved.length, 1)
  const other = await request('extension.operate', { ...params, params: { title: 'Twice' } })
  assert.equal(codeOf(other), 'command_id_conflict')
  assert.equal(saved.length, 1)
})

test('a paired client reads with extensions:read, operates only with extensions:operate, and its operates are audited', async () => {
  const { hub, saved } = hubWithBoard()
  const reader = await caller(hub, (started) => pairFakeClient(started.auth, 'reader', ['extensions:read']))
  assert.deepEqual(answerOf(await reader.request('extension.read', { moduleId: 'acme.board', method: 'cards.list' })), {
    ok: true,
    result: [],
  })
  const refused = await reader.request('extension.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'No' },
    commandId: 'c1',
  })
  assert.equal(codeOf(refused), 'scope_required')
  assert.equal(saved.length, 0)

  const operator = await caller(hub, (started) => pairFakeClient(started.auth, 'operator', ['extensions:operate']))
  await operator.request('extension.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'Yes' },
    commandId: 'c1',
  })
  assert.deepEqual(saved, [{ title: 'Yes', clientId: 'operator', commandId: 'client:operator:c1' }])
  assert.equal(
    operator.started.audit.some(
      (entry) =>
        entry.tool === 'extension.operate' && entry.moduleId === 'acme.board' && entry.moduleMethod === 'cards.add',
    ),
    true,
    'an operate from a paired client is audited',
  )
  // A read-only grant without extensions:read reaches nothing.
  const none = await caller(hub, (started) => pairFakeClient(started.auth, 'none', ['conversation:read']))
  assert.equal(
    codeOf(await none.request('extension.read', { moduleId: 'acme.board', method: 'cards.list' })),
    'scope_required',
  )
})

test('a Studio with no kernel yet answers extension_unavailable; one without modules does not serve the methods', async () => {
  const { request } = await caller(createStudioModuleHub())
  assert.equal(
    codeOf(await request('extension.read', { moduleId: 'acme.board', method: 'cards.list' })),
    'extension_unavailable',
  )
})

// ── The host calls an extension's frames make ───────────────────────────────

/** A real kernel running `acme.board`, with Backlog and usage registries that record each call. */
function hubWithServices(provide: { backlog?: boolean; usage?: boolean } = { backlog: true, usage: true }) {
  const kernel = createMainKernel({
    resolveModuleManifest: (id) =>
      id === 'acme.board'
        ? {
            id,
            displayName: 'Board',
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            permissions: ['backlog:read', 'backlog:operate', 'usage:read'],
          }
        : undefined,
  })
  const calls: unknown[][] = []
  const host = kernel.hostFor('@host')
  if (provide.backlog)
    host.provideService(createServiceToken<Omit<ModuleBacklogRegistry, 'list'>>('backlog.module-service'), () => ({
      getLocation: async (...args) => {
        calls.push(['getLocation', ...args])
        return { ok: true, location: { root: 'backlog', isDefault: true, exists: true } }
      },
      create: async (...args) => {
        calls.push(['create', ...args])
        return args[2].title === 'denied'
          ? { ok: false, code: 'not_permitted', message: 'No backlog:operate.' }
          : { ok: true, id: 'backlog/unfiled/x.md', relativePath: 'unfiled/x.md', path: '/p/x.md' }
      },
      updateStatus: async (...args) => {
        calls.push(['updateStatus', ...args])
        return { ok: true }
      },
      updateTriage: async (...args) => {
        calls.push(['updateTriage', ...args])
        return { ok: true }
      },
      addLink: async (...args) => {
        calls.push(['addLink', ...args])
        return { ok: true }
      },
      updateModuleMetadata: async (...args) => {
        calls.push(['updateModuleMetadata', ...args])
        return { ok: true }
      },
    }))
  if (provide.usage)
    host.provideService(createServiceToken<Pick<ModuleUsageRegistry, 'query'>>('usage.module-service'), () => ({
      query: async (...args) => {
        calls.push(['query', ...args])
        return { ok: true, rows: [], scannedAt: 5, sources: [] }
      },
    }))
  const hub = createStudioModuleHub()
  hub.serveFrameCallsFrom((request) => kernel.callFrameMethod(request))
  return { hub, calls }
}

/** One frame call over the socket, under a fresh command id unless one is given. */
let nextCommand = 0
type Frame = { t: string; ok?: boolean; result?: unknown; error?: { code: string } }
const frameCall = (
  request: (method: string, params: unknown) => Promise<Frame>,
  method: string,
  params: unknown,
  moduleId = 'acme.board',
  commandId = `fc${(nextCommand += 1)}`,
) => request('extension.call', { moduleId, frame: 'a'.repeat(64), method, params, commandId })

test('a frame’s Backlog and usage calls reach the services under its extension’s id, their answers as results', async () => {
  const { hub, calls } = hubWithServices()
  const { request } = await caller(hub)
  const at = { workspaceId: 'ws-1' }
  assert.deepEqual(answerOf(await frameCall(request, 'backlog.location', at)), {
    ok: true,
    result: { ok: true, location: { root: 'backlog', isDefault: true, exists: true } },
  })
  const item = { ...at, itemId: 'backlog/a.md' }
  await frameCall(request, 'backlog.create', { ...at, input: { title: 'Ship' } })
  await frameCall(request, 'backlog.updateStatus', { ...item, status: 'ready' })
  await frameCall(request, 'backlog.updateTriage', { ...item, triage: { risk: null } })
  await frameCall(request, 'backlog.updateModuleMetadata', { ...item, value: { lane: 1 } })
  assert.deepEqual(answerOf(await frameCall(request, 'usage.query', { query: { from: 0, to: 9 } })), {
    ok: true,
    result: { ok: true, rows: [], scannedAt: 5, sources: [] },
  })
  assert.deepEqual(calls, [
    ['getLocation', 'acme.board', 'ws-1'],
    ['create', 'acme.board', 'ws-1', { title: 'Ship' }],
    ['updateStatus', 'acme.board', 'ws-1', 'backlog/a.md', 'ready'],
    ['updateTriage', 'acme.board', 'ws-1', 'backlog/a.md', { risk: null }],
    ['updateModuleMetadata', 'acme.board', 'ws-1', 'backlog/a.md', { lane: 1 }],
    ['query', 'acme.board', { from: 0, to: 9 }],
  ])
})

test('a frame call for an extension not running here, or a service not provided, is refused in an answer', async () => {
  const { hub, calls } = hubWithServices({ backlog: false })
  const { request } = await caller(hub)
  const gone = answerOf(await frameCall(request, 'backlog.location', { workspaceId: 'ws-1' }, 'acme.gone')) as {
    code?: string
  }
  assert.equal(gone.code, 'approval_required')
  const host = answerOf(await frameCall(request, 'usage.query', { query: { from: 0, to: 1 } }, '@host')) as {
    code?: string
  }
  assert.equal(host.code, 'approval_required', 'the host is not an extension a client speaks for')
  const missing = answerOf(await frameCall(request, 'backlog.location', { workspaceId: 'ws-1' })) as { code?: string }
  assert.equal(missing.code, 'unavailable')
  assert.equal(calls.length, 0)
  const before = await caller(createStudioModuleHub())
  const early = answerOf(await frameCall(before.request, 'usage.query', { query: { from: 0, to: 1 } })) as {
    code?: string
  }
  assert.equal(early.code, 'unavailable', 'before the kernel exists')
})

test('a retried frame call is carried out once', async () => {
  const { hub, calls } = hubWithServices()
  const { request } = await caller(hub)
  const params = { workspaceId: 'ws-1', input: { title: 'Once' } }
  const first = await frameCall(request, 'backlog.create', params, 'acme.board', 'same')
  assert.deepEqual(answerOf(await frameCall(request, 'backlog.create', params, 'acme.board', 'same')), answerOf(first))
  assert.equal(calls.length, 1)
  assert.equal(
    codeOf(await frameCall(request, 'backlog.create', { ...params, input: { title: 'Twice' } }, 'acme.board', 'same')),
    'command_id_conflict',
  )
})

test('a paired client’s frame calls are held to what the client itself holds, and audited', async () => {
  const { hub, calls } = hubWithServices()
  const reader = await caller(hub, (started) =>
    pairFakeClient(started.auth, 'reader', ['extensions:read', 'workspaces:read']),
  )
  assert.equal(
    (answerOf(await frameCall(reader.request, 'usage.query', { query: { from: 0, to: 1 } })) as { ok: boolean }).ok,
    true,
  )
  // The extension may write the Backlog; a client that may not cannot write it through the extension.
  const refused = answerOf(
    await frameCall(reader.request, 'backlog.create', { workspaceId: 'ws-1', input: { title: 'No' } }),
  ) as { ok: boolean; code?: string; message?: string }
  assert.equal(refused.code, 'not_permitted', JSON.stringify(refused))
  assert.match(refused.message ?? '', /needs "backlog:operate", which "reader" does not hold/)
  const operator = await caller(hub, (started) =>
    pairFakeClient(started.auth, 'operator', ['extensions:operate', 'backlog:operate']),
  )
  await frameCall(operator.request, 'backlog.create', { workspaceId: 'ws-1', input: { title: 'Yes' } })
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['query', 'create'],
  )
  assert.equal(
    operator.started.audit.some((entry) => entry.tool === 'extension.call' && entry.moduleId === 'acme.board'),
    true,
    'a call from a paired client is audited',
  )
})

// ── What runs here ───────────────────────────────────────────────────────────

test('before the kernel is wired the list is empty and a change is refused unavailable, never lost silently', async () => {
  const { request } = await caller(createStudioModuleHub())
  assert.deepEqual(answerOf(await request('extension.list', {})), { modules: [] })
  assert.equal(
    codeOf(await request('extension.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1' })),
    'unavailable',
  )
})

test('the installed list names a folder Studio could not read by its place only to an owner; a paired client gets its name', async () => {
  const hub = createStudioModuleHub()
  const rejected = [
    {
      path: '/Users/dev/.sprintengine/extensions/local.broken/extension.json',
      issues: [{ path: 'id', message: 'missing' }],
    },
    {
      path: 'C:\\Users\\dev\\.sprintengine\\extensions\\local.windows\\extension.json',
      issues: [
        {
          path: '',
          message:
            "ENOENT: no such file or directory, open 'C:\\Users\\dev\\.sprintengine\\extensions\\local.windows\\extension.json'",
        },
      ],
    },
    {
      path: '/Users/dev/.sprintengine/extensions/acme-folder/',
      issues: [{ path: '', message: 'see /Users/dev/elsewhere/notes.txt' }],
    },
  ]
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async () => ({ ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    approve: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    devFolders: async () => [],
    devLoad: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
    devUnload: async () => ({ ok: false, code: 'not_found', message: 'no' }),
    installed: async () => ({ modules: [], rejected }),
    contributions: async () => ({ extensions: [], failures: {} }),
    frame: async () => ({ ok: false, message: 'none' }),
    content: async () => ({ ok: false, message: 'none' }),
    settings: async () => ({ ok: false, message: 'none' }),
    setSetting: async () => ({ ok: false, message: 'none' }),
    reportRegistry: () => ({ ok: true }),
    reproject: async () => undefined,
    catalogue: NO_CATALOGUE,
  })
  const owner = await caller(hub)
  assert.deepEqual(answerOf(await owner.request('extension.installed', {})), { modules: [], rejected })
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['extensions:read']))
  const seen = answerOf(await paired.request('extension.installed', {}))
  assert.ok(!JSON.stringify(seen).includes('Users'), JSON.stringify(seen))
  assert.deepEqual(seen, {
    modules: [],
    rejected: [
      { path: 'local.broken', issues: [{ path: 'id', message: 'missing' }] },
      {
        path: 'local.windows',
        issues: [{ path: '', message: "ENOENT: no such file or directory, open 'local.windows\\extension.json'" }],
      },
      { path: 'acme-folder', issues: [{ path: '', message: 'Studio could not read this folder.' }] },
    ],
  })
})

test('a change to what runs is an owner’s: a paired client holding extensions:operate is refused it', async () => {
  const hub = createStudioModuleHub()
  const changes: string[] = []
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async (moduleId) => (changes.push(moduleId), { ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    approve: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    devFolders: async () => [],
    devLoad: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
    devUnload: async () => ({ ok: false, code: 'not_found', message: 'no' }),
    installed: async () => ({ modules: [], rejected: [] }),
    contributions: async () => ({ extensions: [], failures: {} }),
    frame: async () => ({ ok: false, message: 'none' }),
    content: async () => ({ ok: false, message: 'none' }),
    settings: async () => ({ ok: false, message: 'none' }),
    setSetting: async () => ({ ok: false, message: 'none' }),
    reportRegistry: () => ({ ok: true }),
    reproject: async () => undefined,
    catalogue: NO_CATALOGUE,
  })
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['extensions:operate']))
  assert.deepEqual(answerOf(await paired.request('extension.list', {})), { modules: [] })
  assert.equal(
    codeOf(await paired.request('extension.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1' })),
    'owner_required',
  )
  const owner = await caller(hub)
  const params = { moduleId: 'acme', enabled: false, commandId: 'c1' }
  assert.deepEqual(answerOf(await owner.request('extension.setEnabled', params)), { ok: true, module: null })
  await owner.request('extension.setEnabled', params)
  assert.deepEqual(changes, ['acme'], 'a retried change is carried out once')
})

test('the window’s module report is an owner’s: a paired client holding extensions:operate cannot replace it', async () => {
  const hub = createStudioModuleHub()
  const reported: unknown[] = []
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async () => ({ ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    approve: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    devFolders: async () => [],
    devLoad: async () => ({ ok: false, code: 'unavailable', message: 'no' }),
    devUnload: async () => ({ ok: false, code: 'not_found', message: 'no' }),
    installed: async () => ({ modules: [], rejected: [] }),
    contributions: async () => ({ extensions: [], failures: {} }),
    frame: async () => ({ ok: false, message: 'none' }),
    content: async () => ({ ok: false, message: 'none' }),
    settings: async () => ({ ok: false, message: 'none' }),
    setSetting: async () => ({ ok: false, message: 'none' }),
    reportRegistry: (snapshot) => (reported.push(snapshot), { ok: true }),
    reproject: async () => undefined,
    catalogue: NO_CATALOGUE,
  })
  const snapshot = { modules: [] }
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['extensions:operate']))
  assert.equal(
    codeOf(await paired.request('extension.reportRegistry', { snapshot, commandId: 'r1' })),
    'owner_required',
  )
  assert.deepEqual(reported, [], 'nothing a paired client sent was kept')
  const owner = await caller(hub)
  assert.deepEqual(answerOf(await owner.request('extension.reportRegistry', { snapshot, commandId: 'r2' })), {
    ok: true,
  })
  assert.deepEqual(reported, [snapshot])
})

test('a frame changes an extension’s settings only for a client that may change Studio’s settings', async () => {
  // A real kernel running `acme.tuned`, which holds `settings:own`, over a store of its settings.
  const kernel = createMainKernel({
    resolveModuleManifest: (id) =>
      id === 'acme.tuned'
        ? {
            id,
            displayName: 'Tuned',
            version: 1,
            defaultEnabled: true,
            source: 'third-party',
            permissions: ['settings:own'],
          }
        : undefined,
  })
  const values: Record<string, unknown> = { indent: 2 }
  kernel.hostFor('@host').provideService(
    createServiceToken<{
      get(moduleId: string): Record<string, unknown>
      setValue(moduleId: string, key: string, value: unknown): void
      subscribe(): () => void
    }>('core.module-app-state'),
    () => ({
      get: () => ({ ...values }),
      setValue: (_moduleId, key, value) => {
        values[key] = value
      },
      subscribe: () => () => undefined,
    }),
  )
  const hub = createStudioModuleHub()
  hub.serveFrameCallsFrom((request) => kernel.callFrameMethod(request))

  // Paired with extensions and without `settings:write`, as a tailnet browser or a narrow pairing is.
  const paired = await caller(hub, (started) =>
    pairFakeClient(started.auth, 'narrow', ['extensions:read', 'extensions:operate']),
  )
  assert.deepEqual(answerOf(await frameCall(paired.request, 'settings.get', {}, 'acme.tuned')), {
    ok: true,
    result: { indent: 2 },
  })
  const refused = answerOf(await frameCall(paired.request, 'settings.set', { key: 'indent', value: 4 }, 'acme.tuned'))
  assert.equal((refused as { code?: string }).code, 'not_permitted')
  assert.equal(values.indent, 2, 'nothing was written')

  const owner = await caller(hub)
  assert.deepEqual(
    answerOf(await frameCall(owner.request, 'settings.set', { key: 'indent', value: 4 }, 'acme.tuned')),
    { ok: true, result: { ok: true } },
  )
  assert.equal(values.indent, 4)
})
