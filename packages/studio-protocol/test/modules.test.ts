import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_ERROR_CODES } from '../src/envelope'
import { STUDIO_EXTENSION_FRAMES_CAPABILITY, STUDIO_EXTENSION_HOST_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, parseStudioMethodParams } from '../src/methods'
import {
  STUDIO_MODULE_METHOD_MAX_CHARS,
  STUDIO_MODULES_METHODS,
  STUDIO_MODULES_OWNER,
  isStudioModuleMethodName,
} from '../src/modules'
import { STUDIO_SCOPE_PERMISSIONS, studioGrantPrincipal } from '../src/permissions'
import { studioScopesGrant } from '../src/scopes'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('a module method is read under extensions:read and operated under extensions:operate, behind the extension-host capability', () => {
  for (const method of ['extension.read', 'extension.operate', 'extension.list'] as const) {
    const spec = STUDIO_MODULES_METHODS[method]
    assert.equal(spec.owner, undefined, `${method} is not held to an owner`)
    assert.equal(spec.capability, STUDIO_EXTENSION_HOST_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method], spec, method)
  }
  assert.equal(STUDIO_MODULES_METHODS['extension.list'].scope, 'extensions:read')
  assert.equal(STUDIO_MODULES_METHODS['extension.read'].scope, 'extensions:read')
  assert.equal(STUDIO_MODULES_METHODS['extension.read'].mutation, false)
  assert.equal(STUDIO_MODULES_METHODS['extension.operate'].scope, 'extensions:operate')
  assert.equal(STUDIO_MODULES_METHODS['extension.operate'].mutation, true)
  for (const code of ['extension_unavailable', 'extension_method_unknown'])
    assert.equal((STUDIO_ERROR_CODES as readonly string[]).includes(code), true, code)
})

test('extensions:operate carries extensions:read, as the other operate scopes carry their read', () => {
  assert.deepEqual(STUDIO_SCOPE_PERMISSIONS['extensions:operate'], ['extension:read', 'extension:operate'])
  assert.equal(studioScopesGrant(['extensions:operate'], 'extensions:read'), true)
  assert.equal(studioScopesGrant(['extensions:read'], 'extensions:operate'), false)
  const reader = studioGrantPrincipal({ owner: false, scopes: ['extensions:read'] })
  assert.equal(reader.permissions.has('extension:operate'), false)
})

test('a read names the module and its method, keeps its params as they came, and drops what it does not define', () => {
  assert.deepEqual(
    parseStudioMethodParams('extension.read', { moduleId: 'acme', method: 'items.list', params: { a: [1] }, extra: 1 }),
    { ok: true, params: { moduleId: 'acme', method: 'items.list', params: { a: [1] } } },
  )
  assert.deepEqual(parseStudioMethodParams('extension.read', { moduleId: 'acme', method: 'items.list' }), {
    ok: true,
    params: { moduleId: 'acme', method: 'items.list' },
  })
  assert.equal(refusal(parseStudioMethodParams('extension.read', { method: 'items.list' })), 'invalid_params')
  assert.equal(refusal(parseStudioMethodParams('extension.read', { moduleId: '', method: 'x' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('extension.read', { moduleId: 'acme', method: 'Items' })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.read', { moduleId: 'acme', method: 'acme:list' })),
    'invalid_params',
  )
})

test('an operate is a read plus the client’s commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('extension.operate', {
      moduleId: 'acme',
      method: 'items.add',
      params: 'x',
      commandId: 'c1',
    }),
    { ok: true, params: { moduleId: 'acme', method: 'items.add', params: 'x', commandId: 'c1' } },
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.operate', { moduleId: 'acme', method: 'items.add' })),
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

// ── An extension's frames ─────────────────────────────────────────────────

test('a frame’s document and its host calls are offered under extension-frames, read under extensions:read', () => {
  for (const method of ['extension.frame', 'extension.call'] as const) {
    assert.equal(STUDIO_MODULES_METHODS[method].scope, 'extensions:read')
    assert.equal(STUDIO_MODULES_METHODS[method].capability, STUDIO_EXTENSION_FRAMES_CAPABILITY)
  }
  assert.equal(STUDIO_MODULES_METHODS['extension.frame'].mutation, false)
  // A call may write, so it carries a command id and a retry is answered from its receipt.
  assert.equal(STUDIO_MODULES_METHODS['extension.call'].mutation, true)
})

test('a frame names its extension, the surface and, when it has one, the client’s theme', () => {
  assert.deepEqual(
    parseStudioMethodParams('extension.frame', {
      moduleId: 'local.a',
      point: 'doors',
      id: 'deck',
      theme: 'nord',
      x: 1,
    }),
    { ok: true, params: { moduleId: 'local.a', point: 'doors', id: 'deck', theme: 'nord' } },
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.frame', { moduleId: 'local.a', point: 'menus', id: 'x' })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.frame', { moduleId: 'local.a', point: 'panels', id: '' })),
    'invalid_params',
  )
})

test('a host call names its extension and a frame method, keeps its params as they came, and carries a commandId', () => {
  const call = { moduleId: 'local.a', method: 'files.read', params: { workspaceId: 'w', path: 'a.md' } }
  assert.deepEqual(parseStudioMethodParams('extension.call', { ...call, commandId: 'c1', extra: true }), {
    ok: true,
    params: { ...call, commandId: 'c1' },
  })
  assert.equal(refusal(parseStudioMethodParams('extension.call', call)), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('extension.call', { ...call, method: '../x', commandId: 'c' })),
    'invalid_params',
  )
})

test('switching, installing, trusting and uninstalling a module are an owner’s commands, with the reason said', () => {
  for (const method of [
    'extension.setEnabled',
    'extension.install',
    'extension.approve',
    'extension.uninstall',
  ] as const) {
    const spec = STUDIO_MODULES_METHODS[method]
    assert.equal(spec.owner, STUDIO_MODULES_OWNER, method)
    assert.equal(spec.scope, null, method)
    assert.equal(spec.mutation, true, method)
    assert.equal(spec.capability, STUDIO_EXTENSION_HOST_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method], spec, method)
  }
  assert.match(STUDIO_MODULES_OWNER, /changes what runs on this machine/)
})

test('a lifecycle command names its module or folder and carries a commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('extension.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1', x: 1 }),
    { ok: true, params: { moduleId: 'acme', enabled: false, commandId: 'c1' } },
  )
  assert.deepEqual(
    parseStudioMethodParams('extension.setEnabled', { moduleId: 'acme', enabled: null, commandId: 'c1' }),
    {
      ok: true,
      params: { moduleId: 'acme', enabled: null, commandId: 'c1' },
    },
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.setEnabled', { moduleId: 'acme', enabled: 'no', commandId: 'c1' })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('extension.setEnabled', { moduleId: 'acme', enabled: true })),
    'invalid_params',
  )
  assert.deepEqual(parseStudioMethodParams('extension.install', { path: '/Users/dev/deck', commandId: 'c1' }), {
    ok: true,
    params: { path: '/Users/dev/deck', commandId: 'c1' },
  })
  assert.equal(refusal(parseStudioMethodParams('extension.install', { path: ' ', commandId: 'c1' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('extension.approve', { moduleId: 'acme', fingerprint: 'abc', commandId: 'c1' })),
    'invalid_params',
  )
  assert.deepEqual(
    parseStudioMethodParams('extension.approve', { moduleId: 'acme', fingerprint: 'sha256-ab12', commandId: 'c1' }),
    { ok: true, params: { moduleId: 'acme', fingerprint: 'sha256-ab12', commandId: 'c1' } },
  )
  assert.deepEqual(parseStudioMethodParams('extension.uninstall', { moduleId: 'acme', commandId: 'c1' }), {
    ok: true,
    params: { moduleId: 'acme', commandId: 'c1' },
  })
})
