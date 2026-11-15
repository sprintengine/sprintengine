import assert from 'node:assert/strict'
import { test } from 'vitest'

import { StudioError } from '../../../../packages/client-runtime/src/public'
import { STUDIO_PROTOCOL_VERSION } from '../../../../packages/studio-protocol/src/public'
import { peerRefusal } from '../../../main/automation/tailnet/tailnet-peer-studio'
import { environmentRefusal } from './environmentStudio'

// A Studio a release ahead of this window: its window starts past this app's.
const newer = { protocolVersion: STUDIO_PROTOCOL_VERSION + 2, minProtocolVersion: STUDIO_PROTOCOL_VERSION + 1 }
const refusedByNewer = () =>
  new StudioError('unsupported_protocol_version', 'Update the other end.', undefined, undefined, newer)

test('a Studio ahead of this app is not blamed: the window and main say to update this app', () => {
  const words = `This Studio needs Studio protocol ${newer.minProtocolVersion} or newer, and this app speaks ${STUDIO_PROTOCOL_VERSION}. Update this app.`
  assert.deepEqual(environmentRefusal({ name: 'build-box' }, refusedByNewer()), {
    kind: 'incompatible',
    code: 'unsupported_protocol_version',
    message: words,
  })
  assert.deepEqual(peerRefusal({ machineName: 'build-box' }, refusedByNewer()), {
    kind: 'incompatible',
    code: 'unsupported_protocol_version',
    message: words,
  })
})

test('a Studio older than what was asked is still the machine to update, and a machine away is unavailable', () => {
  assert.deepEqual(environmentRefusal({ name: 'build-box' }, new StudioError('outdated', '')), {
    kind: 'outdated',
    code: 'outdated',
    message: 'Update SprintEngine Studio on build-box to use this from here.',
  })
  assert.equal(environmentRefusal({ name: 'build-box' }, new StudioError('unknown_method', 'No.')).kind, 'outdated')
  assert.equal(peerRefusal({ machineName: 'build-box' }, new StudioError('unknown_method', 'No.')).kind, 'outdated')
  for (const code of ['unavailable', 'closed', 'disconnected', 'hello_timeout'])
    assert.equal(environmentRefusal({ name: 'build-box' }, new StudioError(code, 'Away.')).kind, 'unavailable')
  assert.equal(environmentRefusal({ name: 'build-box' }, new StudioError('scope_required', 'No.')).kind, 'unauthorized')
  assert.equal(environmentRefusal({ name: 'build-box' }, new StudioError('not_found', 'No.')).kind, 'refused')
})
