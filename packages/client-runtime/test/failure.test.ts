import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_PROTOCOL_VERSION } from '../src/protocol'
import { StudioError, isStudioVersionFailure, presentStudioFailure } from '../src/public'

const newer = { protocolVersion: STUDIO_PROTOCOL_VERSION + 2, minProtocolVersion: STUDIO_PROTOCOL_VERSION + 1 }

test('a version refusal names the side to update from the Studio window, never from the refusal words', () => {
  // A Studio's words are written from its own end: "Update this end" means the Studio.
  const refused = new StudioError(
    'unsupported_protocol_version',
    'The other end speaks Studio protocol 1, and this one needs 2 or newer. Update the other end.',
    undefined,
    undefined,
    newer,
  )
  assert.deepEqual(presentStudioFailure(refused), {
    kind: 'client-outdated',
    message: `This Studio needs Studio protocol ${newer.minProtocolVersion} or newer, and this app speaks ${STUDIO_PROTOCOL_VERSION}. Update this app.`,
  })
  // Its version, once it has said it, is named too.
  const welcomed = new StudioError('unsupported_protocol_version', '', undefined, undefined, {
    ...newer,
    version: '9.0.0',
  })
  assert.match(presentStudioFailure(welcomed).message, /^This Studio \(9\.0\.0\) needs/)
  // A Studio that did not say its window: neither side is blamed.
  const unsaid = presentStudioFailure(new StudioError('unsupported_protocol_version', 'Update this end.'))
  assert.equal(unsaid.kind, 'incompatible')
  assert.match(unsaid.message, /Update whichever is older\./)
  for (const kind of ['client-outdated', 'server-outdated', 'incompatible'] as const)
    assert.equal(isStudioVersionFailure(kind), true)
  for (const kind of ['unauthorized', 'forbidden', 'connection', 'refused'] as const)
    assert.equal(isStudioVersionFailure(kind), false)
})

test('every other failure is read into the kind a client acts on', () => {
  const kindOf = (code: string) => presentStudioFailure(new StudioError(code, 'Words.')).kind
  // A Studio older than what was asked of it: a client's own words stand, a method's are replaced.
  assert.deepEqual(presentStudioFailure(new StudioError('outdated', 'Update the desktop.')), {
    kind: 'server-outdated',
    message: 'Update the desktop.',
  })
  assert.deepEqual(presentStudioFailure(new StudioError('unknown_method', 'Unknown method "x.y".')), {
    kind: 'server-outdated',
    message: 'This Studio is older than this app and does not serve this. Update the Studio.',
  })
  assert.deepEqual(['unauthorized', 'revoked', 'peer_mismatch'].map(kindOf), Array(3).fill('unauthorized'))
  assert.deepEqual(['scope_required', 'owner_required'].map(kindOf), ['forbidden', 'forbidden'])
  assert.deepEqual(
    ['offline', 'disconnected', 'closed', 'hello_timeout', 'shutting_down', 'busy'].map(kindOf),
    Array(6).fill('connection'),
  )
  // Studio's own `unavailable` is a refusal of the request, in its words.
  assert.deepEqual(presentStudioFailure(new StudioError('unavailable', 'The model is not available.')), {
    kind: 'refused',
    message: 'The model is not available.',
  })
  assert.deepEqual(presentStudioFailure(new Error('socket hang up')), {
    kind: 'connection',
    message: 'socket hang up',
  })
})
