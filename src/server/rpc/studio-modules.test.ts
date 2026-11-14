import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioModuleEvent, StudioModuleNotification } from '../../../packages/studio-protocol/src/public'
import { createMainKernel, createServiceToken } from '../../main/module-host/main-host'
import type { ModuleUsageRegistry } from '../../shared/modules/activity-service'
import type { ModuleBacklogRegistry } from '../../shared/modules/backlog-service'
import type { ModuleMethodParsed } from '../../shared/modules/methods'
import { createStudioModuleHub, type StudioModules } from './studio-modules'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `module.events` and `module.notifications` over the owner socket: the
// capability, the scope, the module filter, and the bell's kept rows sent
// before the live ones. The hub is the real one; the kernel behind it is not
// here (module-events.test.ts and module-notifications.test.ts hold it).
// `module.read` and `module.operate` are called through the hub into a real
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
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('modules'), true)
  const without = await clientOver(undefined)
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('modules'), false)
  without.client.send({ t: 'sub', id: 's1', topic: 'module.events', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test("every module's events, or one module's, in the order the kernel delivered them", async () => {
  const { hub, listening } = hubWithListening()
  const { client } = await clientOver(hub)
  const both = listening()
  client.send({ t: 'sub', id: 'all', topic: 'module.events', params: {} })
  await both
  const one = listening()
  client.send({ t: 'sub', id: 'radar', topic: 'module.events', params: { moduleId: 'acme.radar' } })
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

test('a malformed module filter is refused', async () => {
  const { client } = await clientOver(createStudioModuleHub())
  client.send({ t: 'sub', id: 's1', topic: 'module.events', params: { moduleId: 7 } })
  const failed = await client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'invalid_params')
})

test('the bell sends the kept rows first, then each new one, and again on a new subscription', async () => {
  const { hub, listening } = hubWithListening()
  const kept = [row('k1-0', 'Failed to load')]
  hub.readRecentFrom(() => kept)
  const { client } = await clientOver(hub)
  const subscribed = listening()
  client.send({ t: 'sub', id: 'bell', topic: 'module.notifications', params: {} })
  await subscribed
  kept.push(row('k1-1', 'Standup ready'))
  hub.deliverNotification(row('k1-1', 'Standup ready'))
  const first = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  const second = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  assert.deepEqual(
    [first, second].map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'k1-1'],
  )
  client.send({ t: 'sub', id: 'again', topic: 'module.notifications', params: {} })
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

test('a paired client needs modules:read, and holds it only when granted', async () => {
  const hub = createStudioModuleHub()
  const without = await clientOver(hub, (started) => pairFakeClient(started.auth, 'app', ['conversation:read']))
  without.client.send({ t: 'sub', id: 's1', topic: 'module.notifications', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')

  const { hub: watched, listening } = hubWithListening()
  const granted = await clientOver(watched, (started) => pairFakeClient(started.auth, 'reader', ['modules:read']))
  const subscribed = listening()
  granted.client.send({ t: 'sub', id: 's2', topic: 'module.events', params: {} })
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
            permissions: ['module:bridge'],
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
  const added = await request('module.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'Ship it' },
    commandId: 'c1',
  })
  assert.deepEqual(answerOf(added), { ok: true, result: { count: 1 } })
  assert.deepEqual(saved, [{ title: 'Ship it', clientId: 'owner', commandId: 'owner:c1' }])
  assert.deepEqual(answerOf(await request('module.read', { moduleId: 'acme.board', method: 'cards.list' })), {
    ok: true,
    result: ['Ship it'],
  })
  const taken = await request('module.operate', {
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
    codeOf(await request('module.read', { moduleId: 'acme.gone', method: 'cards.list' })),
    'module_unavailable',
  )
  assert.equal(
    codeOf(await request('module.read', { moduleId: 'acme.board', method: 'cards.burn' })),
    'module_method_unknown',
  )
  assert.equal(
    codeOf(await request('module.read', { moduleId: 'acme.board', method: 'cards.add' })),
    'module_method_unknown',
  )
  const refused = await request('module.operate', {
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
  const first = await request('module.operate', params)
  const again = await request('module.operate', params)
  assert.deepEqual(answerOf(again), answerOf(first))
  assert.equal(saved.length, 1)
  const other = await request('module.operate', { ...params, params: { title: 'Twice' } })
  assert.equal(codeOf(other), 'command_id_conflict')
  assert.equal(saved.length, 1)
})

test('a paired client reads with modules:read, operates only with modules:operate, and its operates are audited', async () => {
  const { hub, saved } = hubWithBoard()
  const reader = await caller(hub, (started) => pairFakeClient(started.auth, 'reader', ['modules:read']))
  assert.deepEqual(answerOf(await reader.request('module.read', { moduleId: 'acme.board', method: 'cards.list' })), {
    ok: true,
    result: [],
  })
  const refused = await reader.request('module.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'No' },
    commandId: 'c1',
  })
  assert.equal(codeOf(refused), 'scope_required')
  assert.equal(saved.length, 0)

  const operator = await caller(hub, (started) => pairFakeClient(started.auth, 'operator', ['modules:operate']))
  await operator.request('module.operate', {
    moduleId: 'acme.board',
    method: 'cards.add',
    params: { title: 'Yes' },
    commandId: 'c1',
  })
  assert.deepEqual(saved, [{ title: 'Yes', clientId: 'operator', commandId: 'client:operator:c1' }])
  assert.equal(
    operator.started.audit.some(
      (entry) =>
        entry.tool === 'module.operate' && entry.moduleId === 'acme.board' && entry.moduleMethod === 'cards.add',
    ),
    true,
    'an operate from a paired client is audited',
  )
  // A read-only grant without modules:read reaches nothing.
  const none = await caller(hub, (started) => pairFakeClient(started.auth, 'none', ['conversation:read']))
  assert.equal(
    codeOf(await none.request('module.read', { moduleId: 'acme.board', method: 'cards.list' })),
    'scope_required',
  )
})

test('a Studio with no kernel yet answers module_unavailable; one without modules does not serve the methods', async () => {
  const { request } = await caller(createStudioModuleHub())
  assert.equal(
    codeOf(await request('module.read', { moduleId: 'acme.board', method: 'cards.list' })),
    'module_unavailable',
  )
})

// ── The host's services a module's window half calls ──────────────────────

/** A real kernel running `acme.board`, with Backlog and usage registries that record each call. */
function hubWithServices(provide: { backlog?: boolean; usage?: boolean } = { backlog: true, usage: true }) {
  const kernel = createMainKernel({
    resolveModuleManifest: (id) =>
      id === 'acme.board'
        ? { id, displayName: 'Board', version: 1, defaultEnabled: true, source: 'third-party', permissions: [] }
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
          ? { ok: false, code: 'permission_missing', message: 'No backlog.write.' }
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
  hub.serveHostServicesFrom((moduleId) => kernel.hostServicesFor(moduleId))
  return { hub, calls }
}

test('a module’s Backlog writes and usage query reach the services under its id, their answers as results', async () => {
  const { hub, calls } = hubWithServices()
  const { request } = await caller(hub)
  const at = { moduleId: 'acme.board', workspaceId: 'ws-1' }
  assert.deepEqual(answerOf(await request('moduleBacklog.location', at)), {
    ok: true,
    location: { root: 'backlog', isDefault: true, exists: true },
  })
  assert.deepEqual(
    answerOf(await request('moduleBacklog.create', { ...at, input: { title: 'Ship' }, commandId: 'c1' })),
    { ok: true, id: 'backlog/unfiled/x.md', relativePath: 'unfiled/x.md', path: '/p/x.md' },
  )
  const item = { ...at, itemId: 'backlog/a.md' }
  await request('moduleBacklog.updateStatus', { ...item, status: 'ready', commandId: 'c2' })
  await request('moduleBacklog.updateTriage', { ...item, triage: { risk: null }, commandId: 'c3' })
  const link = { id: 'l', type: 'external', label: 'L', target: { kind: 'url', id: 'u' } }
  await request('moduleBacklog.addLink', { ...item, link, commandId: 'c4' })
  await request('moduleBacklog.updateModuleMetadata', { ...item, value: { lane: 1 }, commandId: 'c5' })
  assert.deepEqual(
    answerOf(await request('moduleUsage.query', { moduleId: 'acme.board', query: { from: 0, to: 9 } })),
    { ok: true, rows: [], scannedAt: 5, sources: [] },
  )
  assert.deepEqual(calls, [
    ['getLocation', 'acme.board', 'ws-1'],
    ['create', 'acme.board', 'ws-1', { title: 'Ship' }],
    ['updateStatus', 'acme.board', 'ws-1', 'backlog/a.md', 'ready'],
    ['updateTriage', 'acme.board', 'ws-1', 'backlog/a.md', { risk: null }],
    ['addLink', 'acme.board', 'ws-1', 'backlog/a.md', link],
    ['updateModuleMetadata', 'acme.board', 'ws-1', 'backlog/a.md', { lane: 1 }],
    ['query', 'acme.board', { from: 0, to: 9 }],
  ])
  // The service's own refusal is the answer, in its words.
  assert.deepEqual(
    answerOf(await request('moduleBacklog.create', { ...at, input: { title: 'denied' }, commandId: 'c6' })),
    { ok: false, code: 'permission_missing', message: 'No backlog.write.' },
  )
})

test('a host-service call for a module not running here is module_unavailable; a service not provided answers in its words', async () => {
  const { hub, calls } = hubWithServices({ backlog: false })
  const { request } = await caller(hub)
  assert.equal(
    codeOf(await request('moduleBacklog.location', { moduleId: 'acme.gone', workspaceId: 'ws-1' })),
    'module_unavailable',
  )
  assert.equal(
    codeOf(await request('moduleUsage.query', { moduleId: '@host', query: { from: 0, to: 1 } })),
    'module_unavailable',
    'the host is not a module a client speaks for',
  )
  const missing = answerOf(await request('moduleBacklog.location', { moduleId: 'acme.board', workspaceId: 'ws-1' }))
  assert.equal((missing as { code?: string }).code, 'backlog_unavailable')
  assert.equal(calls.length, 0)
  const before = await caller(createStudioModuleHub())
  assert.equal(
    codeOf(await before.request('moduleUsage.query', { moduleId: 'acme.board', query: { from: 0, to: 1 } })),
    'module_unavailable',
    'before the kernel exists',
  )
})

test('a retried Backlog write is carried out once', async () => {
  const { hub, calls } = hubWithServices()
  const { request } = await caller(hub)
  const params = { moduleId: 'acme.board', workspaceId: 'ws-1', input: { title: 'Once' }, commandId: 'c1' }
  const first = await request('moduleBacklog.create', params)
  assert.deepEqual(answerOf(await request('moduleBacklog.create', params)), answerOf(first))
  assert.equal(calls.length, 1)
  assert.equal(
    codeOf(await request('moduleBacklog.create', { ...params, input: { title: 'Twice' } })),
    'command_id_conflict',
  )
})

test('a paired client reads the host services with modules:read and writes them only with modules:operate', async () => {
  const { hub, calls } = hubWithServices()
  const reader = await caller(hub, (started) => pairFakeClient(started.auth, 'reader', ['modules:read']))
  assert.equal(
    (
      answerOf(await reader.request('moduleUsage.query', { moduleId: 'acme.board', query: { from: 0, to: 1 } })) as {
        ok: boolean
      }
    ).ok,
    true,
  )
  const write = { moduleId: 'acme.board', workspaceId: 'ws-1', input: { title: 'No' }, commandId: 'c1' }
  assert.equal(codeOf(await reader.request('moduleBacklog.create', write)), 'scope_required')
  const operator = await caller(hub, (started) => pairFakeClient(started.auth, 'operator', ['modules:operate']))
  await operator.request('moduleBacklog.create', { ...write, input: { title: 'Yes' } })
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['query', 'create'],
  )
  assert.equal(
    operator.started.audit.some((entry) => entry.tool === 'moduleBacklog.create' && entry.moduleId === 'acme.board'),
    true,
    'a write from a paired client is audited',
  )
})

// ── What runs here ───────────────────────────────────────────────────────────

test('before the kernel is wired the list is empty and a change is refused unavailable, never lost silently', async () => {
  const { request } = await caller(createStudioModuleHub())
  assert.deepEqual(answerOf(await request('module.list', {})), { modules: [] })
  assert.equal(
    codeOf(await request('module.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1' })),
    'unavailable',
  )
})

test('the installed list names a folder Studio could not read by its place only to an owner; a paired client gets its name', async () => {
  const hub = createStudioModuleHub()
  const rejected = [
    {
      path: '/Users/dev/Library/Application Support/SprintEngine/modules/acme-broken/manifest.json',
      issues: [{ path: 'id', message: 'missing' }],
    },
    {
      path: 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine\\modules\\acme-windows\\manifest.json',
      issues: [
        {
          path: '',
          message:
            "ENOENT: no such file or directory, open 'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine\\modules\\acme-windows\\manifest.json'",
        },
      ],
    },
    { path: '/Users/dev/modules/acme-folder/', issues: [{ path: '', message: 'see /Users/dev/elsewhere/notes.txt' }] },
  ]
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async () => ({ ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    setTrust: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    installed: async () => ({ modules: [], rejected }),
    rendererEntries: async () => ({ entries: [], failures: {} }),
    setAppState: () => undefined,
    reportRegistry: () => ({ ok: true }),
  })
  const owner = await caller(hub)
  assert.deepEqual(answerOf(await owner.request('module.installed', {})), { modules: [], rejected })
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['modules:read']))
  const seen = answerOf(await paired.request('module.installed', {}))
  assert.ok(!JSON.stringify(seen).includes('Users'), JSON.stringify(seen))
  assert.deepEqual(seen, {
    modules: [],
    rejected: [
      { path: 'acme-broken', issues: [{ path: 'id', message: 'missing' }] },
      {
        path: 'acme-windows',
        issues: [{ path: '', message: "ENOENT: no such file or directory, open 'acme-windows\\manifest.json'" }],
      },
      { path: 'acme-folder', issues: [{ path: '', message: 'Studio could not read this folder.' }] },
    ],
  })
})

test('a change to what runs is an owner’s: a paired client holding modules:operate is refused it', async () => {
  const hub = createStudioModuleHub()
  const changes: string[] = []
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async (moduleId) => (changes.push(moduleId), { ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    setTrust: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    installed: async () => ({ modules: [], rejected: [] }),
    rendererEntries: async () => ({ entries: [], failures: {} }),
    setAppState: () => undefined,
    reportRegistry: () => ({ ok: true }),
  })
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['modules:operate']))
  assert.deepEqual(answerOf(await paired.request('module.list', {})), { modules: [] })
  assert.equal(
    codeOf(await paired.request('module.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1' })),
    'owner_required',
  )
  const owner = await caller(hub)
  const params = { moduleId: 'acme', enabled: false, commandId: 'c1' }
  assert.deepEqual(answerOf(await owner.request('module.setEnabled', params)), { ok: true, module: null })
  await owner.request('module.setEnabled', params)
  assert.deepEqual(changes, ['acme'], 'a retried change is carried out once')
})

test('the window’s module report is an owner’s: a paired client holding modules:operate cannot replace it', async () => {
  const hub = createStudioModuleHub()
  const reported: unknown[] = []
  hub.serveLifecycleFrom({
    list: () => [],
    setEnabled: async () => ({ ok: true, module: null }),
    install: async () => ({ ok: false, message: 'no' }),
    setTrust: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true, removedModuleIds: [] }),
    installed: async () => ({ modules: [], rejected: [] }),
    rendererEntries: async () => ({ entries: [], failures: {} }),
    setAppState: () => undefined,
    reportRegistry: (snapshot) => (reported.push(snapshot), { ok: true }),
  })
  const snapshot = { modules: [] }
  const paired = await caller(hub, (started) => pairFakeClient(started.auth, 'tablet', ['modules:operate']))
  assert.equal(codeOf(await paired.request('module.reportRegistry', { snapshot, commandId: 'r1' })), 'owner_required')
  assert.deepEqual(reported, [], 'nothing a paired client sent was kept')
  const owner = await caller(hub)
  assert.deepEqual(answerOf(await owner.request('module.reportRegistry', { snapshot, commandId: 'r2' })), { ok: true })
  assert.deepEqual(reported, [snapshot])
})
