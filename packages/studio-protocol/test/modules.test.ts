import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_ERROR_CODES } from '../src/envelope'
import { STUDIO_MODULES_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, parseStudioMethodParams } from '../src/methods'
import { STUDIO_MODULE_METHOD_MAX_CHARS, STUDIO_MODULES_METHODS, isStudioModuleMethodName } from '../src/modules'
import { STUDIO_SCOPE_PERMISSIONS, studioGrantPrincipal } from '../src/permissions'
import { studioScopesGrant } from '../src/scopes'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('a module method is read under modules:read and operated under modules:operate, behind the modules capability', () => {
  for (const [method, spec] of Object.entries(STUDIO_MODULES_METHODS)) {
    assert.equal(spec.owner, undefined, `${method} is not held to an owner`)
    assert.equal(spec.capability, STUDIO_MODULES_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, method)
  }
  assert.equal(STUDIO_MODULES_METHODS['module.read'].scope, 'modules:read')
  assert.equal(STUDIO_MODULES_METHODS['module.read'].mutation, false)
  assert.equal(STUDIO_MODULES_METHODS['module.operate'].scope, 'modules:operate')
  assert.equal(STUDIO_MODULES_METHODS['module.operate'].mutation, true)
  for (const code of ['module_unavailable', 'module_method_unknown'])
    assert.equal((STUDIO_ERROR_CODES as readonly string[]).includes(code), true, code)
})

test('modules:operate carries modules:read, as the other operate scopes carry their read', () => {
  assert.deepEqual(STUDIO_SCOPE_PERMISSIONS['modules:operate'], ['module:read', 'module:operate'])
  assert.equal(studioScopesGrant(['modules:operate'], 'modules:read'), true)
  assert.equal(studioScopesGrant(['modules:read'], 'modules:operate'), false)
  const reader = studioGrantPrincipal({ owner: false, scopes: ['modules:read'] })
  assert.equal(reader.permissions.has('module:operate'), false)
})

test('a read names the module and its method, keeps its params as they came, and drops what it does not define', () => {
  assert.deepEqual(
    parseStudioMethodParams('module.read', { moduleId: 'acme', method: 'items.list', params: { a: [1] }, extra: 1 }),
    { ok: true, params: { moduleId: 'acme', method: 'items.list', params: { a: [1] } } },
  )
  assert.deepEqual(parseStudioMethodParams('module.read', { moduleId: 'acme', method: 'items.list' }), {
    ok: true,
    params: { moduleId: 'acme', method: 'items.list' },
  })
  assert.equal(refusal(parseStudioMethodParams('module.read', { method: 'items.list' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('module.read', { moduleId: '', method: 'x' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('module.read', { moduleId: 'acme', method: 'Items' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('module.read', { moduleId: 'acme', method: 'acme:list' })),
    'invalid_params',
  )
})

test('an operate is a read plus the client’s commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('module.operate', { moduleId: 'acme', method: 'items.add', params: 'x', commandId: 'c1' }),
    { ok: true, params: { moduleId: 'acme', method: 'items.add', params: 'x', commandId: 'c1' } },
  )
  assert.equal(
    refusal(parseStudioMethodParams('module.operate', { moduleId: 'acme', method: 'items.add' })),
    'invalid_params',
  )
})

test('a method name is a lower-case word, then letters, digits, dots and dashes, and bounded', () => {
  for (const name of ['list', 'items.list', 'items.add-one', 'v2.get'])
    assert.equal(isStudioModuleMethodName(name), true, name)
  for (const name of ['', 'List', '1list', '.list', 'acme:list', 'a b', 'a/b', 7, null])
    assert.equal(isStudioModuleMethodName(name), false, String(name))
  assert.equal(isStudioModuleMethodName(`a${'b'.repeat(STUDIO_MODULE_METHOD_MAX_CHARS - 1)}`), true)
  assert.equal(isStudioModuleMethodName(`a${'b'.repeat(STUDIO_MODULE_METHOD_MAX_CHARS)}`), false)
})
