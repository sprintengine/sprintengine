import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_ERROR_CODES, parseStudioServerFrame } from '../src/envelope'
import {
  STUDIO_CAPABILITIES,
  STUDIO_PROTOCOL_WINDOW,
  STUDIO_UPDATE_SESSION_CAPABILITY,
  checkStudioProtocolVersion,
  studioCompatibility,
} from '../src/handshake'
import { STUDIO_METHODS, parseStudioMethodParams } from '../src/methods'
import {
  STUDIO_UPDATE_METHODS,
  STUDIO_UPDATE_SESSION_METHODS,
  parseStudioUpdateStatus,
  studioIncompatibility,
} from '../src/update'

const status = {
  serverVersion: '1.2.3',
  protocolVersion: 3,
  minProtocolVersion: 2,
  method: 'self',
  state: 'ready',
  available: { version: '1.3.0' },
  lastFailure: { version: '1.2.9', message: 'The installer stopped.', at: 1_700_000_000_000 },
  manual: 'Update it by hand.',
}

const incompatible = {
  t: 'incompatible',
  protocolVersion: 3,
  minProtocolVersion: 2,
  server: { name: 'SprintEngine Studio', version: '1.2.3' },
  environment: { id: 'env-1', hostKind: 'ssh', os: 'linux', arch: 'x64' },
  compatibility: 'client-outdated',
  message: 'Update this app.',
  update: status,
}

test('compatibility is read from both windows: each must serve the other', () => {
  const client = { protocolVersion: 3, minProtocolVersion: 2 }
  const rows: Array<[{ protocolVersion: number; minProtocolVersion: number } | null, string]> = [
    [null, 'unknown'],
    [{ protocolVersion: 3, minProtocolVersion: 2 }, 'compatible'],
    // Older, but still inside what the client serves.
    [{ protocolVersion: 2, minProtocolVersion: 1 }, 'compatible'],
    [{ protocolVersion: 1, minProtocolVersion: 1 }, 'server-outdated'],
    [{ protocolVersion: 5, minProtocolVersion: 3 }, 'compatible'],
    [{ protocolVersion: 5, minProtocolVersion: 4 }, 'client-outdated'],
  ]
  for (const [server, expected] of rows)
    assert.deepEqual([server, studioCompatibility(server, client)], [server, expected])
  // The handshake's check is the same rule, from this build's window.
  assert.equal(studioCompatibility(STUDIO_PROTOCOL_WINDOW), 'compatible')
  for (const peer of [
    { protocolVersion: 9, minProtocolVersion: 9 },
    { protocolVersion: 1, minProtocolVersion: 1 },
  ])
    assert.equal(
      checkStudioProtocolVersion(peer.protocolVersion, peer.minProtocolVersion).ok,
      studioCompatibility(peer) === 'compatible',
    )
})

test('the words name both versions and the side to update', () => {
  const server = { version: '1.2.3', protocolVersion: 3, minProtocolVersion: 2 }
  assert.equal(studioIncompatibility(server, { protocolVersion: 2, minProtocolVersion: 2 }), null)
  assert.deepEqual(studioIncompatibility(server, { protocolVersion: 1, minProtocolVersion: 1 }), {
    compatibility: 'client-outdated',
    message: 'This Studio (1.2.3) needs Studio protocol 2 or newer, and this app speaks 1. Update this app.',
  })
  assert.deepEqual(studioIncompatibility(server, { protocolVersion: 6, minProtocolVersion: 4 }), {
    compatibility: 'server-outdated',
    message: 'This Studio (1.2.3) speaks Studio protocol 3, and this app needs 4 or newer. Update the Studio.',
  })
})

// What two ends that disagree on everything else still speak. A change here is
// a change to every client that will ever reach an old Studio, and every old
// client that will reach this one: add optional members only.
test('the update surface keeps its shape: the frame, the two methods, their scopes and codes', () => {
  assert.equal(STUDIO_UPDATE_SESSION_CAPABILITY, 'update-session')
  assert.ok((STUDIO_CAPABILITIES as readonly string[]).includes('update-session'))
  assert.deepEqual([...STUDIO_UPDATE_SESSION_METHODS], ['update.status', 'update.start'])
  assert.deepEqual(Object.keys(STUDIO_UPDATE_METHODS), ['update.status', 'update.start'])
  for (const method of STUDIO_UPDATE_SESSION_METHODS)
    assert.equal(STUDIO_METHODS[method], STUDIO_UPDATE_METHODS[method])
  const { params: _status, ...statusSpec } = STUDIO_UPDATE_METHODS['update.status']
  assert.deepEqual(statusSpec, { scope: null, mutation: false, capability: 'update-session' })
  const { params: _start, ...startSpec } = STUDIO_UPDATE_METHODS['update.start']
  assert.deepEqual(startSpec, { scope: 'environment:maintain', mutation: true, capability: 'update-session' })
  for (const code of ['unsupported_protocol_version', 'update_unavailable'])
    assert.ok((STUDIO_ERROR_CODES as readonly string[]).includes(code), code)
  // The frame as a Studio sends it reads back whole.
  assert.deepEqual(parseStudioServerFrame(incompatible), {
    ...incompatible,
    // Judged again from the versions against this build's window: protocol 2+ needs a newer client.
    compatibility: 'client-outdated',
  })
})

test('update.start takes a command id and an optional version, and drops anything else', () => {
  const read = (params: unknown) => parseStudioMethodParams('update.start', params)
  assert.deepEqual(read({ commandId: 'u1', targetVersion: '1.3.0', extra: true }), {
    ok: true,
    params: { commandId: 'u1', targetVersion: '1.3.0' },
  })
  assert.deepEqual(read({ commandId: 'u1' }), { ok: true, params: { commandId: 'u1' } })
  for (const params of [
    {},
    { commandId: '' },
    { commandId: 'u1', targetVersion: 7 },
    { commandId: 'u1', targetVersion: '' },
  ])
    assert.equal(read(params).ok, false, JSON.stringify(params))
  assert.deepEqual(parseStudioMethodParams('update.status', { anything: 1 }), { ok: true, params: {} })
})

test('a status from a newer Studio reads: unknown members dropped, an unknown method or state read as one this client can act on', () => {
  assert.deepEqual(parseStudioUpdateStatus({ ...status, later: 'member' }), status)
  assert.deepEqual(parseStudioUpdateStatus({ ...status, method: 'relay', state: 'staging' }), {
    ...status,
    method: 'manual',
    state: 'idle',
  })
  // Members in the wrong shape are dropped one by one, not the status.
  assert.deepEqual(
    parseStudioUpdateStatus({ ...status, available: { version: 3 }, lastFailure: { message: 'x' }, manual: 4 }),
    {
      serverVersion: '1.2.3',
      protocolVersion: 3,
      minProtocolVersion: 2,
      method: 'self',
      state: 'ready',
    },
  )
  for (const broken of [null, {}, { ...status, serverVersion: '' }, { ...status, protocolVersion: 0 }])
    assert.equal(parseStudioUpdateStatus(broken), null)
})

test('a frame from a later Studio still reads: a new host kind, long words, members this client does not know', () => {
  const later = parseStudioServerFrame({
    ...incompatible,
    environment: { ...incompatible.environment, hostKind: 'something-new', region: 'x' },
    server: { name: 'S'.repeat(500), version: '1.2.3', build: 'abc' },
    message: 'm'.repeat(5_000),
    update: { ...status, manual: 'w'.repeat(5_000), serverVersion: 'v'.repeat(100) },
    hint: 'later',
  })
  assert.ok(later?.t === 'incompatible')
  assert.deepEqual(later.environment, { id: 'env-1', hostKind: 'other', os: 'linux', arch: 'x64' })
  assert.equal(later.server.name.length, 120)
  assert.equal(later.message.length, 2_000)
  assert.equal(later.update.manual?.length, 2_000)
  assert.equal(later.update.serverVersion.length, 64)
  assert.equal('hint' in later, false)
})

test('an incompatible frame names the side behind this client, judged from its versions where they decide', () => {
  const side = (frame: Record<string, unknown>) => {
    const parsed = parseStudioServerFrame({ ...incompatible, ...frame })
    return parsed?.t === 'incompatible' ? parsed.compatibility : null
  }
  // A Studio needing protocol 2 or newer is ahead of this build, whatever it wrote.
  assert.equal(side({ compatibility: 'server-outdated' }), 'client-outdated')
  // Versions this build speaks (a frame meant for another client): the Studio's word stands,
  // and a word this client does not know is read as its own to update.
  const ours = { protocolVersion: STUDIO_PROTOCOL_WINDOW.protocolVersion, minProtocolVersion: 1 }
  assert.equal(side({ ...ours, compatibility: 'server-outdated' }), 'server-outdated')
  assert.equal(side({ ...ours, compatibility: 'something-new' }), 'client-outdated')
  // A frame missing its update status is not one.
  assert.equal(parseStudioServerFrame({ ...incompatible, update: undefined }), null)
})
