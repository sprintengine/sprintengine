import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  studioNoParams,
  studioParams,
  type StudioHandlersOf,
  type StudioMethodTable,
  type StudioTopicTable,
} from '../src/contract'
import {
  STUDIO_METHODS,
  STUDIO_TOPICS,
  createStudioRpcClient,
  type StudioHandlers,
  type StudioMethod,
  type StudioMethodAnswer,
  type StudioRequest,
  type StudioTopicPayload,
} from '../src/methods'

// The table builds both ends of the protocol. The rows marked
// `@ts-expect-error` are the guarantees: each is a mistake that must not
// compile, so `npm run typecheck:tests` fails the moment one does.

type Map = {
  'a.read': { params: { id: string }; result: { name: string } }
  'a.write': { params: { id: string; commandId: string }; result: { saved: true }; errors: 'conflict' }
}

const scoped = { scope: 'conversation:read', mutation: false, capability: null } as const

test('a table needs a scope and a validator of the right shape for every method', () => {
  const table: StudioMethodTable<Map> = {
    'a.read': { ...scoped, params: (value) => studioParams({ id: String(value.id) }) },
    'a.write': {
      ...scoped,
      mutation: true,
      params: (value) => studioParams({ id: String(value.id), commandId: String(value.commandId) }),
    },
  }
  assert.equal(Object.keys(table).length, 2)

  // @ts-expect-error A method with no definition does not compile.
  const missing: StudioMethodTable<Map> = { 'a.read': table['a.read'] }
  void missing

  const noScope: StudioMethodTable<Map> = {
    // @ts-expect-error A method without a scope declaration does not compile.
    'a.read': { mutation: false, capability: null, params: table['a.read'].params },
    'a.write': table['a.write'],
  }
  void noScope

  const wrongParams: StudioMethodTable<Map> = {
    // @ts-expect-error A validator answering another shape does not compile.
    'a.read': { ...scoped, params: () => studioParams({ id: 1 }) },
    'a.write': table['a.write'],
  }
  void wrongParams
})

test('a handler map needs a handler for every method, answering its result and its declared refusals', async () => {
  const handlers: StudioHandlersOf<Map, null> = {
    'a.read': ({ id }) => ({ ok: true, result: { name: id } }),
    'a.write': () => ({ ok: false, error: { code: 'conflict', message: 'taken' } }),
  }
  assert.deepEqual(await handlers['a.read']({ id: 'x' }, null), { ok: true, result: { name: 'x' } })

  // @ts-expect-error A missing handler does not compile.
  const missing: StudioHandlersOf<Map, null> = { 'a.read': handlers['a.read'] }
  void missing

  const wrongResult: StudioHandlersOf<Map, null> = {
    // @ts-expect-error A handler answering the wrong result does not compile.
    'a.read': () => ({ ok: true, result: { title: 'x' } }),
    'a.write': handlers['a.write'],
  }
  void wrongResult

  const undeclared: StudioHandlersOf<Map, null> = {
    // @ts-expect-error A refusal the method does not declare does not compile.
    'a.read': () => ({ ok: false, error: { code: 'conflict', message: 'taken' } }),
    'a.write': handlers['a.write'],
  }
  void undeclared

  // Every method may answer the common refusals.
  const common: StudioHandlersOf<Map, null> = {
    'a.read': () => ({ ok: false, error: { code: 'unavailable', message: 'no' } }),
    'a.write': () => ({ ok: false, error: { code: 'scope_required', message: 'no' } }),
  }
  void common
})

test('a topic table needs a validator for every topic, and a push topic says so', () => {
  type Topics = {
    'a.changed': { params: Record<string, never>; payload: { ids: string[] }; stream: 'push' }
  }
  const topics: StudioTopicTable<Topics> = {
    'a.changed': { scope: 'conversation:read', capability: 'conversations', push: true, params: studioNoParams },
  }
  assert.equal(topics['a.changed'].push, true)
  const notPush: StudioTopicTable<Topics> = {
    // @ts-expect-error A push topic that does not say it is one does not compile.
    'a.changed': { scope: 'conversation:read', capability: 'conversations', params: studioNoParams },
  }
  void notPush
})

test('every method of the protocol has a scope declaration and a validator; only the server’s own and an owner’s take no scope', () => {
  for (const [method, definition] of Object.entries(STUDIO_METHODS)) {
    assert.ok(Object.hasOwn(definition, 'scope'), method)
    assert.equal(typeof definition.params, 'function', method)
    // `update.status` too: how a client that cannot talk to this Studio recovers.
    // The terminals too: no scope reaches them, and only an owner's connection may.
    if (definition.scope === null)
      assert.ok(method.startsWith('server.') || method === 'update.status' || definition.owner, method)
  }
  for (const [topic, definition] of Object.entries(STUDIO_TOPICS)) {
    assert.ok(definition.scope || definition.owner, topic)
    assert.equal(typeof definition.params, 'function', topic)
  }
})

test('the client is built from the same table: one call per method, through one request', async () => {
  const asked: Array<[string, unknown]> = []
  const request = (async (method: StudioMethod, params: unknown) => {
    asked.push([method, params])
    return method === 'server.ping' ? { at: 7 } : {}
  }) as StudioRequest
  const client = createStudioRpcClient(request)
  assert.deepEqual(Object.keys(client).sort(), Object.keys(STUDIO_METHODS).sort())
  const pinged: { at: number } = await client['server.ping']({})
  assert.deepEqual(pinged, { at: 7 })
  assert.deepEqual(asked, [['server.ping', {}]])
  // @ts-expect-error A call with another method's params does not compile.
  void client['conversation.loadEarlier']({ toolUseId: 't' })
})

test('the protocol’s results and payloads are its own shapes, not open records', () => {
  // A tool's detail names its status; a record of anything would not.
  type Detail = Extract<StudioMethodAnswer<'conversation.toolDetail'>, { ok: true }>['result']['detail']
  const status: Detail['status'] = 'ok'
  // @ts-expect-error A status the contract does not define does not compile.
  const unknownStatus: Detail['status'] = 'maybe'
  void unknownStatus
  const catalog: StudioTopicPayload<'conversation.commands'> = { cli: 'codex', cwd: '/a', commands: [], fetchedAt: 0 }
  assert.equal(status, 'ok')
  assert.equal(catalog.commands.length, 0)
  // The server's handler map is typed over every method of the protocol.
  type Every = keyof StudioHandlers<null>
  const every: Every[] = Object.keys(STUDIO_METHODS) as StudioMethod[]
  assert.ok(every.length > 50)
})

test('a topic spec still says a push topic is one', () => {
  const spec: import('../src/methods').StudioTopicSpec = STUDIO_TOPICS['tools.catalog']
  assert.equal(spec.push, true)
})

test('validators drop members a method does not define', () => {
  // The types check what a contract defines, not what it leaves out (they are
  // not exact), so each validator builds its params member by member.
  const sent = { key: { workspaceId: 'w', agentId: 'a' }, commandId: 'c', message: 'hi', junk: 1 }
  const read = STUDIO_METHODS['conversation.send'].params(sent)
  assert.ok(read.ok)
  assert.equal('junk' in read.params, false)
  const topic = STUDIO_TOPICS['conversation.session'].params({ key: { workspaceId: 'w', agentId: 'a' }, junk: 1 })
  assert.ok(topic.ok)
  assert.equal('junk' in topic.params, false)
})
