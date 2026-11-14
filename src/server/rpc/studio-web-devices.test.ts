import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { STUDIO_WEB_DEVICES_METHODS, type WebDevicesStatus } from '../../../packages/studio-protocol/src/public'
import type { StudioWebDevicesDomain } from './studio-web-devices'
import {
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  connectLineClient,
  startTestServer,
} from './studio-rpc.test-helper'

// The browsers paired with the web listener (`web-devices.ts`): every method
// an owner's, an owner's web tab included; refused to anyone else; offered
// only while the front door has handed its domain over; the stream marks the
// asking browser's own row.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>

function stub() {
  const listeners = new Set<() => void>()
  const done: string[] = []
  let requests: WebDevicesStatus['requests'] = [
    { requestId: 'r1', name: 'Phone', route: 'tailnet', createdAt: 'a', expiresAt: 'b' },
  ]
  const domain: StudioWebDevicesDomain = {
    status: (clientId) => ({
      devices: [
        {
          id: 'owner',
          name: 'Chrome',
          route: 'loopback',
          createdAt: 'a',
          expiresAt: 'b',
          lastSeenAt: null,
          current: clientId === 'owner',
        },
      ],
      requests,
      origins: ['http://127.0.0.1:4791'],
    }),
    revoke: (id) => {
      done.push(`revoke:${id}`)
      return true
    },
    approve: (requestId, code) => {
      done.push(`approve:${requestId}:${code}`)
      requests = []
      listeners.forEach((listener) => listener())
      return { ok: true }
    },
    decline: (requestId) => {
      done.push(`decline:${requestId}`)
      return true
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  return { domain, done }
}

async function attached(server: Awaited<ReturnType<typeof startTestServer>>['server'], browser: boolean) {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const serverSide = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk)
      callback()
    },
  })
  toServer.on('data', (chunk: Buffer) => serverSide.push(chunk))
  server.attach(serverSide, { authenticator: createFakeAuthenticator(), ownWindow: true, browser, audited: true })
  const frames: Frame[] = []
  let buffer = ''
  toClient.setEncoding('utf8')
  toClient.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Frame)
      buffer = buffer.slice(newline + 1)
    }
  })
  const until = async (match: (frame: Frame) => boolean) => {
    for (let tries = 0; tries < 400; tries++) {
      const found = frames.find(match)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`No matching frame in ${JSON.stringify(frames)}`)
  }
  cleanups.push(() => toServer.end())
  toServer.write(`${JSON.stringify(hello({ token: OWNER_TOKEN }))}\n`)
  const welcome = await until((frame) => frame.t === 'welcome')
  let sequence = 0
  return {
    welcome,
    until,
    async request(method: string, params: Record<string, unknown>) {
      const id = `a${++sequence}`
      toServer.write(`${JSON.stringify({ t: 'req', id, method, params })}\n`)
      return until((frame) => frame.t === 'res' && frame.id === id)
    },
    subscribe(topic: string) {
      const id = `s${++sequence}`
      toServer.write(`${JSON.stringify({ t: 'sub', id, topic, params: {} })}\n`)
      return id
    },
  }
}

const errorCode = (answer: unknown) => (answer as { error?: { code?: string } }).error?.code ?? null

const CALLS: Record<keyof typeof STUDIO_WEB_DEVICES_METHODS, Record<string, unknown>> = {
  'webDevices.status': {},
  'webDevices.revoke': { commandId: 'w1', id: 'b2' },
  'webDevices.approve': { commandId: 'w2', requestId: 'r1', code: '123456' },
  'webDevices.decline': { commandId: 'w3', requestId: 'r2' },
}

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_WEB_DEVICES_METHODS).sort())
})

test('an owner’s web tab reaches every method, and a retry is the first answer', async () => {
  const { domain, done } = stub()
  const started = await startTestServer({ webDevices: () => domain })
  cleanups.push(() => started.dispose())
  const tab = await attached(started.server, true)
  assert.ok((tab.welcome.capabilities as string[]).includes('web-devices'))
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, errorCode(await tab.request(method, params))], [method, null])
  await tab.request('webDevices.approve', CALLS['webDevices.approve'])
  assert.deepEqual(done, ['revoke:b2', 'approve:r1:123456', 'decline:r2'])
})

test('a paired app is refused every one, and the stream too', async () => {
  const { domain, done } = stub()
  const started = await startTestServer({ webDevices: () => domain })
  cleanups.push(() => started.dispose())
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: pairFakeClient(started.auth, 'app', ['settings:write', 'workspaces:operate']) }))
  await client.next((frame) => frame.t === 'welcome')
  let sequence = 0
  for (const [method, params] of Object.entries(CALLS)) {
    const id = `c${++sequence}`
    client.send({ t: 'req', id, method, params })
    const answer = await client.next((frame) => frame.t === 'res' && frame.id === id)
    assert.deepEqual([method, errorCode(answer)], [method, 'owner_required'])
  }
  client.send({ t: 'sub', id: 'sub1', topic: 'webDevices.changed', params: {} })
  const refused = (await client.next((frame) => frame.t === 'subFailed')) as unknown as { code: string }
  assert.equal(refused.code, 'owner_required')
  assert.deepEqual(done, [])
})

test('the stream sends the status whole, its own row marked, and again on each change', async () => {
  const { domain } = stub()
  const started = await startTestServer({ webDevices: () => domain })
  cleanups.push(() => started.dispose())
  const tab = await attached(started.server, true)
  const sub = tab.subscribe('webDevices.changed')
  const first = await tab.until((frame) => frame.t === 'push' && frame.sub === sub)
  assert.equal((first.payload as WebDevicesStatus).devices[0]?.current, true)
  await tab.request('webDevices.approve', CALLS['webDevices.approve'])
  await tab.until(
    (frame) => frame.t === 'push' && frame.sub === sub && (frame.payload as WebDevicesStatus).requests.length === 0,
  )
})

test('before the front door hands its domain over, and on a Studio with none, nothing is offered', async () => {
  let domain: StudioWebDevicesDomain | null = null
  const started = await startTestServer({ webDevices: () => domain })
  cleanups.push(() => started.dispose())
  const before = await attached(started.server, true)
  assert.ok(!(before.welcome.capabilities as string[]).includes('web-devices'))
  assert.equal(errorCode(await before.request('webDevices.status', {})), 'unavailable')
  domain = stub().domain
  const after = await attached(started.server, true)
  assert.ok((after.welcome.capabilities as string[]).includes('web-devices'))
})
