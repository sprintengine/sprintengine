import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { afterAll, beforeAll, test } from 'vitest'

import { deviceRig, type DeviceRig } from './tailnet-studio.test-helper'
import {
  TAILNET_CLIENT_UPDATE_MESSAGE,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_RETIRED_PATHS,
  TAILNET_TRANSPORT_VERSION,
} from './tailnet-routes'

// A phone or a desktop from before transport 3 still asks for the routes it
// drove its chats with. Each answers `426 client_update_required` with the
// sentence that says what to do, never a bare not-found, whether it comes
// with a token or none, as a request or as a socket.

let rig: DeviceRig
let token: string

beforeAll(async () => {
  rig = await deviceRig({})
  token = rig.pair(['conversation:read', 'conversation:operate']).token
})

afterAll(async () => {
  await rig?.dispose()
})

const HTTP_ROUTES = [
  ['POST', '/tailnet/v1/upload'],
  ['GET', '/tailnet/v1/conversation-image'],
  ['GET', '/tailnet/v1/conversation-files'],
  ['GET', '/tailnet/v1/conversation-commands'],
] as const
const SOCKET_ROUTES = ['/tailnet/v1/conversation', '/tailnet/v1/events', '/tailnet/v1/canvas']

test('every route transport 3 took away is named, and only those', () => {
  assert.deepEqual([...TAILNET_RETIRED_PATHS].sort(), [...HTTP_ROUTES.map(([, path]) => path), ...SOCKET_ROUTES].sort())
  assert.equal(TAILNET_TRANSPORT_VERSION, 3)
})

test('a request for a retired route is told to update the app, with a token or without', async () => {
  for (const [method, path] of HTTP_ROUTES)
    for (const bearer of [token, null]) {
      const answer = await fetch(`http://127.0.0.1:${rig.port()}${path}?workspaceId=w&agentId=a`, {
        method,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        ...(method === 'POST' ? { body: 'bytes' } : {}),
      })
      assert.equal(answer.status, 426, `${method} ${path}`)
      assert.deepEqual(await answer.json(), {
        error: { code: 'client_update_required', message: TAILNET_CLIENT_UPDATE_MESSAGE },
      })
    }
})

/** The raw answer to a WebSocket upgrade of `path`, as an older client's socket reads it. */
function upgrade(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(rig.port(), '127.0.0.1')
    let answer = ''
    socket.on('data', (chunk: Buffer) => (answer += chunk.toString('utf8')))
    socket.on('close', () => resolve(answer))
    socket.on('error', reject)
    socket.write(
      `GET ${path}?ticket=old HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
  })
}

test('a socket on a retired route is refused with the same code and sentence, before its ticket is read', async () => {
  for (const path of SOCKET_ROUTES) {
    const answer = await upgrade(path)
    assert.match(answer, /^HTTP\/1\.1 426 Upgrade Required/u, path)
    assert.match(answer, /X-Tailnet-Error: client_update_required/u, path)
    assert.ok(answer.includes(TAILNET_CLIENT_UPDATE_MESSAGE), path)
  }
})

test('health says transport 3 to anyone, and identity to a paired device', async () => {
  const health = (await (await fetch(`http://127.0.0.1:${rig.port()}${TAILNET_HEALTH_PATH}`)).json()) as Record<
    string,
    unknown
  >
  assert.equal(health.transportVersion, 3)
  const identity = (await (
    await fetch(`http://127.0.0.1:${rig.port()}${TAILNET_IDENTITY_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as Record<string, unknown>
  assert.equal(identity.transportVersion, 3)
})

test('a path that never was a route is still not found', async () => {
  const answer = await fetch(`http://127.0.0.1:${rig.port()}/tailnet/v1/terminal`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(answer.status, 404)
  assert.match(await upgrade('/tailnet/v1/terminal'), /^HTTP\/1\.1 404/u)
})
