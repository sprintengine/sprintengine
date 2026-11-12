import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import type { ModuleMethodParsed } from '../../shared/modules/methods'
import { createMainKernel, type ModuleMethodCallRequest } from './main-host'

// A module's declared methods: registered as a batch, called by module id,
// name and access, refused in the host's words when the module or the method
// is not there, and gone with the module.

function manifest(id: string, overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { id, displayName: id, version: 1, defaultEnabled: true, ...overrides }
}

const MANIFESTS: Record<string, CapabilityManifest> = {
  deck: manifest('deck', { source: 'third-party', permissions: ['module:bridge'] }),
  legacy: manifest('legacy', { source: 'third-party', permissions: ['ipc:invoke'] }),
  quiet: manifest('quiet', { source: 'third-party', permissions: ['network'] }),
  first: manifest('first', { source: 'bundled' }),
}

const anything = (value: unknown): ModuleMethodParsed<unknown> => ({ ok: true, params: value })
const city = (value: unknown): ModuleMethodParsed<{ city: string }> =>
  typeof (value as { city?: unknown } | undefined)?.city === 'string'
    ? { ok: true, params: { city: (value as { city: string }).city } }
    : { ok: false, message: '"city" is a city name.' }

function kernel(active?: (id: string) => boolean) {
  return createMainKernel({
    resolveModuleManifest: (id) => MANIFESTS[id],
    ...(active ? { isModuleActive: active } : {}),
  })
}

const call = (overrides: Partial<ModuleMethodCallRequest>): ModuleMethodCallRequest => ({
  moduleId: 'deck',
  method: 'forecast',
  access: 'read',
  params: { city: 'Oslo' },
  clientId: 'owner',
  ...overrides,
})

test('a read method answers through its validator and handler, told who called', async () => {
  const k = kernel()
  const heard: unknown[] = []
  k.hostFor('deck').registerMethods<{
    forecast: { access: 'read'; params: { city: string }; result: { city: string; sky: string } }
  }>({
    forecast: {
      access: 'read',
      params: city,
      handler: (params, context) => {
        heard.push(context)
        return { ok: true, result: { city: params.city, sky: 'clear' } }
      },
    },
  })
  assert.deepEqual(await k.callModuleMethod(call({})), {
    ok: true,
    answer: { ok: true, result: { city: 'Oslo', sky: 'clear' } },
  })
  assert.deepEqual(heard, [{ clientId: 'owner' }])
  assert.deepEqual(k.declaredMethods('deck'), [{ name: 'forecast', access: 'read' }])
})

test('an operate method hears the client-namespaced command id; a module refusal is its answer', async () => {
  const k = kernel()
  k.hostFor('deck').registerMethods({
    save: {
      access: 'operate',
      params: anything,
      handler: (_params, context) =>
        context.commandId === 'client:app-1:c1'
          ? { ok: false, code: 'duplicate', message: 'Already saved.' }
          : { ok: true, result: null },
    },
  })
  assert.deepEqual(
    await k.callModuleMethod(
      call({ method: 'save', access: 'operate', clientId: 'app-1', commandId: 'client:app-1:c1' }),
    ),
    { ok: true, answer: { ok: false, code: 'duplicate', message: 'Already saved.' } },
  )
})

test('params the validator refuses are invalid_params in the module’s words, and the handler never runs', async () => {
  const k = kernel()
  let ran = false
  k.hostFor('deck').registerMethods({
    forecast: { access: 'read', params: city, handler: () => ((ran = true), { ok: true, result: 1 }) },
  })
  assert.deepEqual(await k.callModuleMethod(call({ params: { town: 'Oslo' } })), {
    ok: false,
    code: 'invalid_params',
    message: '"city" is a city name.',
  })
  assert.equal(ran, false)
})

test('a method is called only through its own access, and an unknown name is told apart from a missing module', async () => {
  const k = kernel((id) => id === 'deck' || id === 'first')
  k.hostFor('deck').registerMethods({
    save: { access: 'operate', params: anything, handler: () => ({ ok: true, result: null }) },
  })
  const asRead = await k.callModuleMethod(call({ method: 'save', access: 'read' }))
  assert.equal(!asRead.ok && asRead.code, 'module_method_unknown')
  assert.match(!asRead.ok ? asRead.message : '', /operate/)
  const unknown = await k.callModuleMethod(call({ method: 'nothing' }))
  assert.equal(!unknown.ok && unknown.code, 'module_method_unknown')
  // A module that runs but declares nothing has no methods, not no module.
  const first = await k.callModuleMethod(call({ moduleId: 'first' }))
  assert.equal(!first.ok && first.code, 'module_method_unknown')
  const missing = await k.callModuleMethod(call({ moduleId: 'gone' }))
  assert.equal(!missing.ok && missing.code, 'module_unavailable')
})

test('a result that is not JSON is the handler’s failure, not an answer', async () => {
  const k = kernel()
  k.hostFor('deck').registerMethods({
    when: { access: 'read', params: anything, handler: () => ({ ok: true, result: new Date(0) }) },
  })
  await assert.rejects(k.callModuleMethod(call({ method: 'when' })), /not JSON/)
})

test('a third-party module needs module:bridge (or the broad ipc:invoke) to declare methods; a bundled one does not', () => {
  const k = kernel()
  const one = { ping: { access: 'read' as const, params: anything, handler: () => ({ ok: true as const, result: 1 }) } }
  assert.throws(() => k.hostFor('quiet').registerMethods(one), /module:bridge/)
  k.hostFor('legacy').registerMethods(one)
  k.hostFor('first').registerMethods(one)
})

test('a batch is validated whole: a bad name, a missing validator or a repeat registers nothing', () => {
  const k = kernel()
  const good = { access: 'read' as const, params: anything, handler: () => ({ ok: true as const, result: 1 }) }
  assert.throws(() => k.hostFor('deck').registerMethods({ ping: good, 'deck:ping': good }), /"deck:ping"/)
  assert.deepEqual(k.declaredMethods('deck'), [])
  assert.throws(() => k.hostFor('deck').registerMethods({ ping: { ...good, params: undefined as never } }), /validator/)
  assert.throws(
    () => k.hostFor('deck').registerMethods({ ping: { ...good, access: 'write' as never } }),
    /"read" or "operate"/,
  )
  k.hostFor('deck').registerMethods({ ping: good })
  assert.throws(() => k.hostFor('deck').registerMethods({ ping: good, pong: good }), /already declares "ping"/)
  assert.deepEqual(k.declaredMethods('deck'), [{ name: 'ping', access: 'read' }])
})

test('unloading a module takes its methods, and a call to it is then module_unavailable', async () => {
  const k = kernel()
  k.hostFor('deck').registerMethods({
    forecast: { access: 'read', params: city, handler: () => ({ ok: true, result: 1 }) },
  })
  await k.unregisterModule('deck')
  assert.deepEqual(k.declaredMethods('deck'), [])
  const after = await k.callModuleMethod(call({}))
  assert.equal(!after.ok && after.code, 'module_unavailable')
})

test('the kernel holds no IPC: it is made without one, and a module has no registerIpc', () => {
  assert.equal(createMainKernel.length, 0)
  assert.equal('registerIpc' in createMainKernel().hostFor('deck'), false)
})
