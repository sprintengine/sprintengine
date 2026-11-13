import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

import { readRemoteIdentity } from './tailnet/tailnet-remote-client'
import {
  checkTailnetTransportVersion,
  TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION,
  TAILNET_TRANSPORT_VERSION,
} from './tailnet/tailnet-routes'
import { test } from 'vitest'

test('tailnet-transport-version', async () => {
  // The tailnet transport's version window, and the handshake that applies it.
  //
  // Both ends of a tailnet are separate installs that update on their own
  // schedule, so the wire carries a version and the handshake has to compare it.
  // Until it did, a peer on a wire this build could not read was accepted and
  // then failed somewhere downstream on a payload shape — far from its cause, and
  // reading as a bug in whatever tool happened to be called.
  //
  // What is pinned here is the shape of that refusal as much as the fact of it: a
  // person with two Studios has to be able to tell from the message which of the
  // two to update, and that is only possible if it names both versions.

  let failures = 0
  // One at a time: several of these bind a real socket, and interleaving them
  // would make a port conflict look like a handshake bug.
  let queue: Promise<void> = Promise.resolve()

  function check(name: string, run: () => void | Promise<void>): void {
    queue = queue.then(async () => {
      try {
        await run()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures++
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    })
  }

  // ── The window itself ────────────────────────────────────────────────────────

  check('the window is a window, and it ends at the version this build speaks', () => {
    // A window that ended anywhere else would mean this build advertises a
    // version it would refuse coming back the other way.
    assert.equal(TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION <= TAILNET_TRANSPORT_VERSION, true)
    for (let version = TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION; version <= TAILNET_TRANSPORT_VERSION; version++) {
      assert.equal(checkTailnetTransportVersion(version), null, `version ${version} is inside the window`)
    }
  })

  check('a version outside the window is refused, in both directions', () => {
    const tooOld = checkTailnetTransportVersion(TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION - 1)
    const tooNew = checkTailnetTransportVersion(TAILNET_TRANSPORT_VERSION + 1)
    assert.equal(tooOld?.code, 'unsupported_transport_version')
    assert.equal(tooNew?.code, 'unsupported_transport_version')
    // Too new matters as much as too old: the machine that updated first is the
    // one whose owner is looking at the error.
    assert.match(tooNew?.message ?? '', new RegExp(`version ${TAILNET_TRANSPORT_VERSION + 1}\\b`, 'u'))
  })

  check('a refusal names the version seen and the versions supported', () => {
    const refusal = checkTailnetTransportVersion(99)
    // Both numbers, because either alone is undiagnosable: one says a version is
    // wrong without saying which install to update.
    assert.match(refusal?.message ?? '', /\b99\b/u)
    assert.match(
      refusal?.message ?? '',
      new RegExp(`${TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION}.${TAILNET_TRANSPORT_VERSION}`, 'u'),
    )
  })

  check('a peer that says nothing readable is refused rather than read as a version', () => {
    // Whatever a misconfigured box on that port answers with, it reaches the
    // parser as an unknown. None of it may be coerced into a number.
    for (const seen of [undefined, null, '2', 2.5, Number.NaN, {}, [], Infinity]) {
      const refusal = checkTailnetTransportVersion(seen)
      assert.equal(refusal?.code, 'unsupported_transport_version', `must refuse: ${String(seen)}`)
      // And it must not report a version, since it did not state one.
      assert.match(refusal?.message ?? '', /did not state a transport version/u)
    }
  })

  // ── The handshake ────────────────────────────────────────────────────────────

  /** A listener that answers `identity` with exactly the body given. */
  async function withIdentity(body: unknown, run: (port: number) => Promise<void>): Promise<void> {
    const server: Server = createServer((request, response) => {
      if (request.url === '/tailnet/v1/identity') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      await run(port)
    } finally {
      server.close()
      await once(server, 'close')
    }
  }

  function identityBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      deviceId: 'dev-1',
      deviceName: 'mac-mini',
      scopes: ['workspace:read'],
      transportVersion: TAILNET_TRANSPORT_VERSION,
      ...overrides,
    }
  }

  check('a peer inside the window completes the handshake', async () => {
    await withIdentity(identityBody({ transportVersion: TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok, true)
      assert.equal(identity.ok && identity.value.deviceName, 'mac-mini')
      assert.equal(identity.ok && identity.value.transportVersion, TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION)
    })
  })

  check('a peer outside the window is refused at the handshake, by name', async () => {
    await withIdentity(identityBody({ transportVersion: TAILNET_TRANSPORT_VERSION + 3 }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok, false)
      assert.equal(identity.ok === false && identity.code, 'unsupported_transport_version')
      // The refusal a person reads in the Remote panel, naming both versions.
      assert.match(identity.ok === false ? identity.message : '', new RegExp(`${TAILNET_TRANSPORT_VERSION + 3}`, 'u'))
      assert.match(
        identity.ok === false ? identity.message : '',
        new RegExp(`${TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION}.${TAILNET_TRANSPORT_VERSION}`, 'u'),
      )
    })
  })

  check('a handshake that states no version is refused, not assumed current', async () => {
    const body = identityBody()
    delete body.transportVersion
    await withIdentity(body, async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok === false && identity.code, 'unsupported_transport_version')
    })
  })

  check('the handshake says which Studio answered, and an older or malformed one says none', async () => {
    const environmentId = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
    await withIdentity(identityBody({ environmentId }), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok && identity.value.environmentId, environmentId)
    })
    // A build from before the member: the same handshake, with no id.
    await withIdentity(identityBody(), async (port) => {
      const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
      assert.equal(identity.ok, true)
      assert.equal(identity.ok && identity.value.environmentId, null)
    })
    for (const bad of [42, '', 'a:b', 'x'.repeat(129)])
      await withIdentity(identityBody({ environmentId: bad }), async (port) => {
        const identity = await readRemoteIdentity({ endpoint: { host: '127.0.0.1', port }, token: 'tok' })
        assert.equal(identity.ok && identity.value.environmentId, null, String(bad))
      })
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet transport version tests passed')
  })

  await suiteRun
})
