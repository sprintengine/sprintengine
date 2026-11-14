// What a desktop does about the server an SSH machine's probe found: attach,
// start, upgrade or refuse, decided from the protocol window
// (design-server-update, 6) and a failed update's record (7). The probe and
// the script themselves run against a real shell in ssh-connect.test.ts.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { locateServer, parseProbe, recordWindow, type Located } from './ssh-connect-script'

const APP = { version: '1.5.0', window: { protocolVersion: 3, minProtocolVersion: 2 } }

type Record = {
  version?: string
  origin?: string
  backendWire?: number
  protocolVersion?: number
  minProtocolVersion?: number
}

function probe(record: Record | null, options: { alive?: boolean; failed?: object } = {}) {
  const parsed = parseProbe([
    '@@SPRINTENGINE_PROBE proto=1',
    '@@SPRINTENGINE_PROBE hostname=build-box',
    '@@SPRINTENGINE_PROBE lock_host=build-box',
    '@@SPRINTENGINE_PROBE lock_pid=42',
    `@@SPRINTENGINE_PROBE lock_alive=${options.alive === false ? '0' : '1'}`,
    ...(record ? [`@@SPRINTENGINE_PROBE server_json=${JSON.stringify({ hostId: 'host:build-box', ...record })}`] : []),
    ...(options.failed ? [`@@SPRINTENGINE_PROBE update_failed=${JSON.stringify(options.failed)}`] : []),
    '@@SPRINTENGINE_PROBE end=1',
  ])
  assert.ok(parsed)
  return parsed
}

const server = (version: string, window: [number, number] | null, extra: Record = {}): Record => ({
  version,
  origin: 'bootstrap',
  ...(window ? { protocolVersion: window[0], minProtocolVersion: window[1] } : {}),
  ...extra,
})

const kind = (located: Located) =>
  located.action === 'blocked' ? `blocked${located.offerUpgrade ? '+offer' : ''}` : located.action

test('compatibility is the protocol window, not equal versions', () => {
  const rows: Array<[string, Record, string]> = [
    ['the same build', server('1.5.0', [3, 2]), 'attach'],
    // A newer server whose window still serves this app is used, not refused.
    ['a newer server that still speaks ours', server('1.6.0', [4, 3]), 'attach'],
    // An external one that speaks ours is used as it is; it is not replaced unasked.
    ['an older external server that speaks ours', server('1.4.0', [2, 1], { origin: 'cli' }), 'attach'],
    // One this desktop started is kept current.
    ['an older desktop-started server that speaks ours', server('1.4.0', [2, 1]), 'upgrade'],
    ['an older desktop-started server too old', server('1.0.0', [1, 1]), 'upgrade'],
    ['an older external server too old', server('1.0.0', [1, 1], { origin: 'systemd' }), 'blocked+offer'],
    // A newer server is never replaced; the row says to update this app.
    ['a newer server past this app', server('2.0.0', [5, 4]), 'blocked'],
    ['a newer server with no window', server('2.0.0', null), 'blocked'],
    ['an older desktop-started server with no window', server('1.0.0', null), 'upgrade'],
    // This build's own server, read without its window, is not replaced by itself.
    ['the same build with no window', server('1.5.0', null), 'attach'],
    ['a server whose version does not read', server('?', null), 'blocked'],
    // A record an older server wrote may name the backend wire it spoke: no input, the protocol window decides.
    ['the same build on another backend wire', server('1.5.0', [3, 2], { backendWire: 99 }), 'attach'],
    ['a newer server on another backend wire that speaks ours', server('1.6.0', [3, 2], { backendWire: 1 }), 'attach'],
  ]
  for (const [name, record, expected] of rows)
    assert.equal(kind(locateServer(probe(record), APP, 'build-box')), expected, name)
})

test('the refusals say which side to update', () => {
  const newer = locateServer(probe(server('2.0.0', [5, 4])), APP, 'build-box')
  assert.match(
    newer.action === 'blocked' ? newer.reason : '',
    /needs a newer Studio than this app \(1\.5\.0\)\. Update this app/u,
  )
  const external = locateServer(probe(server('1.0.0', [1, 1], { origin: 'cli' })), APP, 'build-box')
  assert.match(external.action === 'blocked' ? external.reason : '', /started outside this app.*Update it to connect/u)
})

test('a failed update to this version is not tried again on its own: the row says what failed and offers Retry', () => {
  const failed = {
    from: '1.4.0',
    to: '1.5.0',
    at: 1_700_000_000_000,
    reason: 'The Studio server did not start. EADDRINUSE',
  }
  const fellBack = locateServer(probe(server('1.4.0', [2, 1]), { failed }), APP, 'build-box')
  assert.deepEqual(fellBack, {
    action: 'blocked',
    reason:
      'Updating the Studio server on build-box to 1.5.0 failed, so 1.4.0 runs again: The Studio server did not start. EADDRINUSE',
    offerUpgrade: true,
    failedUpdate: failed,
  })
  // Nothing runs (the previous tree did not start either): still not tried on its own.
  const nothing = locateServer(probe(null, { alive: false, failed }), APP, 'build-box')
  assert.equal(kind(nothing), 'blocked+offer')
  assert.match(nothing.action === 'blocked' ? nothing.reason : '', /1\.4\.0 did not start again either/u)
  // An update to another version (this app moved on since) goes ahead.
  const other = { ...failed, to: '1.4.5' }
  assert.deepEqual(locateServer(probe(server('1.4.0', [2, 1]), { failed: other }), APP, 'build-box'), {
    action: 'upgrade',
    from: '1.4.0',
  })
  assert.deepEqual(locateServer(probe(null, { alive: false, failed: other }), APP, 'build-box'), { action: 'start' })
  // A server that serves this app is attached, whatever failed before.
  assert.equal(kind(locateServer(probe(server('1.6.0', [3, 2]), { failed }), APP, 'build-box')), 'attach')
})

test("a record's window reads only when both ends are whole versions", () => {
  assert.deepEqual(recordWindow({ protocolVersion: 3, minProtocolVersion: 2 }), {
    protocolVersion: 3,
    minProtocolVersion: 2,
  })
  for (const record of [
    null,
    {},
    { protocolVersion: 3 },
    { protocolVersion: '3', minProtocolVersion: 2 },
    { protocolVersion: 0, minProtocolVersion: 0 },
  ])
    assert.equal(recordWindow(record), null)
  // A failed update's record that does not read is no record.
  assert.equal(probe(null, { failed: { to: '1.5.0' } }).updateFailed, null)
})
