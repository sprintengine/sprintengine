import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_CONTAINERS_METHODS, STUDIO_CONTAINERS_TOPICS } from '../src/containers'
import { STUDIO_CAPABILITIES, STUDIO_CONTAINERS_CAPABILITY } from '../src/handshake'
import { STUDIO_METHODS, STUDIO_TOPICS, parseStudioMethodParams } from '../src/methods'
import { authorizeStudioMethod } from '../src/public'

const refusal = (parsed: { ok: boolean; code?: string }) => (parsed.ok ? null : parsed.code)
const COMMAND = { commandId: 'c-1' }
const SAVED_ID = '0123456789abcdef'

test('every containers method and its stream is an owner’s, behind the containers capability', () => {
  assert.ok(STUDIO_CAPABILITIES.includes(STUDIO_CONTAINERS_CAPABILITY))
  for (const [method, spec] of Object.entries(STUDIO_CONTAINERS_METHODS)) {
    assert.ok(spec.owner, `${method} is an owner's`)
    assert.equal(spec.capability, STUDIO_CONTAINERS_CAPABILITY, method)
    assert.equal(STUDIO_METHODS[method as keyof typeof STUDIO_METHODS], spec, method)
  }
  assert.equal(STUDIO_TOPICS['containers.changed'], STUDIO_CONTAINERS_TOPICS['containers.changed'])
  assert.ok(STUDIO_CONTAINERS_TOPICS['containers.changed'].owner)
  // Making one starts a chat's machine; the rest change or read what a host has.
  assert.equal(STUDIO_CONTAINERS_METHODS['containers.create'].scope, 'conversation:create')
  for (const method of ['containers.create', 'containers.push', 'containers.remove', 'containers.startDocker'] as const)
    assert.equal(STUDIO_CONTAINERS_METHODS[method].mutation, true, `${method} carries a command id`)
  for (const method of ['containers.status', 'containers.list'] as const)
    assert.equal(STUDIO_CONTAINERS_METHODS[method].mutation, false, method)
})

test('every method and the stream is Studio’s own desktop windows’: not a web tab’s, nor a script’s', () => {
  // Making one starts a chat outside the folders a tailnet browser may start
  // one in, and on SSH machines reached from the desktop alone; a status may
  // raise a passphrase dialog here; the token is a keychain credential.
  for (const [method, spec] of Object.entries(STUDIO_CONTAINERS_METHODS))
    assert.ok((spec.window ?? '').length > 20, `${method} says why it is the windows'`)
  assert.ok(STUDIO_CONTAINERS_TOPICS['containers.changed'].window)
})

test('create, push and remove are answered from what the desktop kept, beyond a restart of its server', () => {
  for (const method of ['containers.create', 'containers.push', 'containers.remove'] as const)
    assert.equal(STUDIO_CONTAINERS_METHODS[method].receipts, 'durable', method)
  for (const method of ['containers.startDocker', 'containers.setToken', 'containers.clearToken'] as const)
    assert.equal(STUDIO_CONTAINERS_METHODS[method].receipts, undefined, method)
})

test('no paired grant reaches a container: not the making, the push, the removal or the list', () => {
  const paired = {
    clientId: 'phone',
    clientName: 'Phone',
    owner: false,
    // Everything a pairing can be given.
    scopes: [
      'conversation:read',
      'conversation:operate',
      'conversation:create',
      'workspaces:read',
      'workspaces:operate',
      'settings:write',
      'environment:maintain',
    ],
  }
  for (const method of Object.keys(STUDIO_CONTAINERS_METHODS) as Array<keyof typeof STUDIO_CONTAINERS_METHODS>) {
    const decision = authorizeStudioMethod(paired, method)
    assert.deepEqual(decision, { ok: false, reason: 'owner_required' }, method)
    assert.deepEqual(authorizeStudioMethod({ ...paired, owner: true }, method).ok, true, `an owner reaches ${method}`)
  }
})

test('a host is this computer or a saved SSH machine; anything else is refused in words', () => {
  assert.deepEqual(parseStudioMethodParams('containers.status', { host: { kind: 'local' } }), {
    ok: true,
    params: { host: { kind: 'local' } },
  })
  assert.deepEqual(parseStudioMethodParams('containers.status', { host: { kind: 'ssh', machine: 'build-box_1' } }), {
    ok: true,
    params: { host: { kind: 'ssh', machine: 'build-box_1' } },
  })
  for (const host of [undefined, null, { kind: 'wsl' }, { kind: 'ssh' }, { kind: 'ssh', machine: 'a b' }]) {
    const parsed = parseStudioMethodParams('containers.status', { host })
    assert.equal(refusal(parsed), 'invalid_params', JSON.stringify(host))
    assert.match((parsed as { message: string }).message, /"host" names the machine/u)
  }
})

test('a create carries its command id, a folder or null, a label and Studio’s own image', () => {
  const parsed = parseStudioMethodParams('containers.create', {
    ...COMMAND,
    host: { kind: 'local' },
    folder: '/Users/dev/proj',
    label: 'Fix the build',
    extra: true,
  })
  assert.deepEqual(parsed, {
    ok: true,
    params: {
      commandId: 'c-1',
      host: { kind: 'local' },
      folder: '/Users/dev/proj',
      label: 'Fix the build',
      image: { kind: 'studio-default' },
    },
  })
  const empty = parseStudioMethodParams('containers.create', { ...COMMAND, host: { kind: 'local' } })
  assert.deepEqual(empty.ok && empty.params, {
    commandId: 'c-1',
    host: { kind: 'local' },
    folder: null,
    label: '',
    image: { kind: 'studio-default' },
  })
  assert.equal(refusal(parseStudioMethodParams('containers.create', { host: { kind: 'local' } })), 'invalid_params')
  for (const bad of [
    { folder: '' },
    { folder: '   ' },
    { folder: 'a\0b' },
    { folder: 'x'.repeat(4097) },
    { label: 'x'.repeat(201) },
    { image: { kind: 'devcontainer' } },
  ])
    assert.equal(
      refusal(parseStudioMethodParams('containers.create', { ...COMMAND, host: { kind: 'local' }, ...bad })),
      'invalid_params',
      JSON.stringify(bad).slice(0, 60),
    )
})

test('push and remove name a container Studio made, and nothing else', () => {
  assert.deepEqual(parseStudioMethodParams('containers.push', { ...COMMAND, id: SAVED_ID }), {
    ok: true,
    params: { commandId: 'c-1', id: SAVED_ID },
  })
  for (const id of ['', 'ABCDEF0123456789', '0123', '../etc', `${SAVED_ID}0`])
    assert.equal(refusal(parseStudioMethodParams('containers.push', { ...COMMAND, id })), 'invalid_params', id)
  assert.deepEqual(parseStudioMethodParams('containers.remove', { ...COMMAND, id: SAVED_ID }), {
    ok: true,
    params: { commandId: 'c-1', id: SAVED_ID },
  })
  // One Docker has with Studio's label and no record here: by its host, name and context.
  assert.deepEqual(
    parseStudioMethodParams('containers.remove', {
      ...COMMAND,
      host: { kind: 'ssh', machine: 'build-box' },
      name: `sprintengine-${SAVED_ID}`,
      context: 'colima',
    }),
    {
      ok: true,
      params: {
        commandId: 'c-1',
        host: { kind: 'ssh', machine: 'build-box' },
        name: `sprintengine-${SAVED_ID}`,
        context: 'colima',
      },
    },
  )
  for (const bad of [
    { host: { kind: 'local' }, name: 'postgres' },
    { host: { kind: 'local' }, name: `sprintengine-${SAVED_ID}; rm -rf /` },
    { host: { kind: 'local' }, name: `sprintengine-${SAVED_ID}`, context: '-H tcp://evil' },
    { name: `sprintengine-${SAVED_ID}` },
  ])
    assert.equal(
      refusal(parseStudioMethodParams('containers.remove', { ...COMMAND, ...bad })),
      'invalid_params',
      JSON.stringify(bad),
    )
})

test('a token is a non-empty string of bounded size', () => {
  assert.deepEqual(parseStudioMethodParams('containers.setToken', { ...COMMAND, token: 'sk-ant-oat01-x' }), {
    ok: true,
    params: { commandId: 'c-1', token: 'sk-ant-oat01-x' },
  })
  for (const token of ['', '  ', 42, 'x'.repeat(4097), 'a\0b'])
    assert.equal(
      refusal(parseStudioMethodParams('containers.setToken', { ...COMMAND, token })),
      'invalid_params',
      String(token).slice(0, 20),
    )
})
