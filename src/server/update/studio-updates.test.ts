import assert from 'node:assert/strict'
import { test } from 'vitest'

import { externalStudioUpdates, mirroredStudioUpdates, studioUpdateStatus } from './studio-updates'

test('out of process, the server answers with the state the shell last sent, and asks the shell to start', async () => {
  const asked: Array<{ commandId: string; targetVersion?: string }> = []
  const mirrored = mirroredStudioUpdates(async (input) => {
    asked.push(input)
    return { ok: true, targetVersion: '1.1.0' }
  })
  // Before the shell has said anything: a desktop, with nothing under way.
  assert.deepEqual(mirrored.updates.status(), { method: 'self', state: 'idle' })
  mirrored.mirror({ method: 'self', state: 'ready', available: { version: '1.1.0' }, stray: true })
  assert.deepEqual(mirrored.updates.status(), { method: 'self', state: 'ready', available: { version: '1.1.0' } })
  // Something that is not a status leaves the last one.
  for (const junk of [null, 'ready', { method: 'self', state: 'exploding' }, { method: 'relay', state: 'idle' }])
    mirrored.mirror(junk)
  assert.equal(mirrored.updates.status().state, 'ready')
  assert.deepEqual(await mirrored.updates.start({ commandId: 'c1', targetVersion: '1.1.0' }), {
    ok: true,
    targetVersion: '1.1.0',
  })
  assert.deepEqual(asked, [{ commandId: 'c1', targetVersion: '1.1.0' }], 'the command id reaches the shell')
})

test('a host nothing here can update says how, and refuses to start', async () => {
  const updates = externalStudioUpdates('bootstrap', 'Update the desktop.')
  assert.deepEqual(studioUpdateStatus(updates, { version: '1.0.0', protocolVersion: 1, minProtocolVersion: 1 }), {
    method: 'bootstrap',
    state: 'idle',
    manual: 'Update the desktop.',
    serverVersion: '1.0.0',
    protocolVersion: 1,
    minProtocolVersion: 1,
  })
  assert.deepEqual(await updates.start({ commandId: 'c1' }), { ok: false, message: 'Update the desktop.' })
})
