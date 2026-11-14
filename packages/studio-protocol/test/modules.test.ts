import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_ERROR_CODES } from '../src/envelope'
import { STUDIO_MODULES_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, parseStudioMethodParams } from '../src/methods'
import { STUDIO_MODULE_SERVICES_METHODS } from '../src/module-services'
import {
  STUDIO_MODULE_METHOD_MAX_CHARS,
  STUDIO_MODULES_METHODS,
  STUDIO_MODULES_OWNER,
  isStudioModuleMethodName,
} from '../src/modules'
import { STUDIO_SCOPE_PERMISSIONS, studioGrantPrincipal } from '../src/permissions'
import { studioScopesGrant } from '../src/scopes'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)

test('a module method is read under modules:read and operated under modules:operate, behind the modules capability', () => {
  for (const method of ['module.read', 'module.operate', 'module.list'] as const) {
    const spec = STUDIO_MODULES_METHODS[method]
    assert.equal(spec.owner, undefined, `${method} is not held to an owner`)
    assert.equal(spec.capability, STUDIO_MODULES_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method], spec, method)
  }
  assert.equal(STUDIO_MODULES_METHODS['module.list'].scope, 'modules:read')
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

// ── The host's services a module's window half calls ──────────────────────

test('a module’s host services are read under modules:read and written under modules:operate, behind the modules capability', () => {
  for (const [method, spec] of Object.entries(STUDIO_MODULE_SERVICES_METHODS)) {
    assert.equal(spec.owner, undefined, `${method} is not held to an owner`)
    assert.equal(spec.capability, STUDIO_MODULES_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, method)
    assert.equal(spec.scope, spec.mutation ? 'modules:operate' : 'modules:read', method)
  }
  assert.deepEqual(
    Object.entries(STUDIO_MODULE_SERVICES_METHODS)
      .filter(([, spec]) => !spec.mutation)
      .map(([method]) => method),
    ['moduleBacklog.location', 'moduleUsage.query'],
  )
})

test('a host-service call names its module, and a write its commandId', () => {
  assert.deepEqual(parseStudioMethodParams('moduleBacklog.location', { moduleId: 'acme', workspaceId: 'ws', x: 1 }), {
    ok: true,
    params: { moduleId: 'acme', workspaceId: 'ws' },
  })
  assert.equal(refusal(parseStudioMethodParams('moduleBacklog.location', { workspaceId: 'ws' })), 'invalid_params')
  const status = { moduleId: 'acme', workspaceId: 'ws', itemId: 'backlog/a.md', status: 'ready' }
  assert.equal(refusal(parseStudioMethodParams('moduleBacklog.updateStatus', status)), 'invalid_params')
  assert.deepEqual(parseStudioMethodParams('moduleBacklog.updateStatus', { ...status, commandId: 'c1' }), {
    ok: true,
    params: { ...status, commandId: 'c1' },
  })
  assert.equal(
    refusal(parseStudioMethodParams('moduleBacklog.updateStatus', { ...status, status: 'done', commandId: 'c1' })),
    'invalid_params',
  )
})

test('a new item, a triage, a link and a usage query are read member by member', () => {
  const at = { moduleId: 'acme', workspaceId: 'ws', commandId: 'c1' }
  assert.deepEqual(
    parseStudioMethodParams('moduleBacklog.create', {
      ...at,
      input: { title: 'Ship', status: 'idea', epic: 'launch', stray: true },
    }),
    { ok: true, params: { ...at, input: { title: 'Ship', status: 'idea', epic: 'launch' } } },
  )
  assert.equal(
    refusal(parseStudioMethodParams('moduleBacklog.create', { ...at, input: { body: 'x' } })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('moduleBacklog.create', { ...at, input: { title: 'x', risk: 3 } })),
    'invalid_params',
  )
  const item = { ...at, itemId: 'backlog/a.md' }
  assert.deepEqual(
    parseStudioMethodParams('moduleBacklog.updateTriage', { ...item, triage: { risk: null, difficulty: 'm', x: 1 } }),
    { ok: true, params: { ...item, triage: { risk: null, difficulty: 'm' } } },
  )
  const link = { id: 'l1', type: 'review', label: 'PR', target: { kind: 'pr', id: '7', url: 'https://example.com/7' } }
  assert.deepEqual(parseStudioMethodParams('moduleBacklog.addLink', { ...item, link: { ...link, extra: 1 } }), {
    ok: true,
    params: { ...item, link },
  })
  assert.equal(
    refusal(parseStudioMethodParams('moduleBacklog.addLink', { ...item, link: { ...link, type: 'other' } })),
    'invalid_params',
  )
  assert.deepEqual(parseStudioMethodParams('moduleBacklog.updateModuleMetadata', { ...item, value: { n: 1 } }), {
    ok: true,
    params: { ...item, value: { n: 1 } },
  })
  assert.deepEqual(parseStudioMethodParams('moduleBacklog.updateModuleMetadata', item), { ok: true, params: item })
  assert.deepEqual(
    parseStudioMethodParams('moduleUsage.query', { moduleId: 'acme', query: { from: 1, to: 2, groupBy: ['day'] } }),
    { ok: true, params: { moduleId: 'acme', query: { from: 1, to: 2, groupBy: ['day'] } } },
  )
  assert.equal(
    refusal(
      parseStudioMethodParams('moduleUsage.query', { moduleId: 'acme', query: { from: 1, to: 2, groupBy: ['week'] } }),
    ),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('moduleUsage.query', { moduleId: 'acme', query: { from: 1 } })),
    'invalid_params',
  )
})

// ── What runs here ─────────────────────────────────────────────────────────

test('switching, installing, trusting and uninstalling a module are an owner’s commands, with the reason said', () => {
  for (const method of ['module.setEnabled', 'module.install', 'module.setTrust', 'module.uninstall'] as const) {
    const spec = STUDIO_MODULES_METHODS[method]
    assert.equal(spec.owner, STUDIO_MODULES_OWNER, method)
    assert.equal(spec.scope, null, method)
    assert.equal(spec.mutation, true, method)
    assert.equal(spec.capability, STUDIO_MODULES_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method], spec, method)
  }
  assert.match(STUDIO_MODULES_OWNER, /changes what runs on this machine/)
})

test('a lifecycle command names its module or folder and carries a commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('module.setEnabled', { moduleId: 'acme', enabled: false, commandId: 'c1', x: 1 }),
    { ok: true, params: { moduleId: 'acme', enabled: false, commandId: 'c1' } },
  )
  assert.deepEqual(parseStudioMethodParams('module.setEnabled', { moduleId: 'acme', enabled: null, commandId: 'c1' }), {
    ok: true,
    params: { moduleId: 'acme', enabled: null, commandId: 'c1' },
  })
  assert.equal(
    refusal(parseStudioMethodParams('module.setEnabled', { moduleId: 'acme', enabled: 'no', commandId: 'c1' })),
    'invalid_params',
  )
  assert.equal(
    refusal(parseStudioMethodParams('module.setEnabled', { moduleId: 'acme', enabled: true })),
    'invalid_params',
  )
  assert.deepEqual(parseStudioMethodParams('module.install', { path: '/Users/dev/deck', commandId: 'c1' }), {
    ok: true,
    params: { path: '/Users/dev/deck', commandId: 'c1' },
  })
  assert.equal(refusal(parseStudioMethodParams('module.install', { path: ' ', commandId: 'c1' })), 'invalid_params')
  assert.equal(
    refusal(parseStudioMethodParams('module.setTrust', { moduleId: 'acme', trusted: 1, commandId: 'c1' })),
    'invalid_params',
  )
  assert.deepEqual(parseStudioMethodParams('module.uninstall', { moduleId: 'acme', commandId: 'c1' }), {
    ok: true,
    params: { moduleId: 'acme', commandId: 'c1' },
  })
})
