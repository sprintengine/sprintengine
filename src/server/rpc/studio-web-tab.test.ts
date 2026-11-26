import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { STUDIO_WEB_TAB_METHODS, type PreviewSummary } from '../../../packages/studio-protocol/src/public'
import type { StudioWebTabDomain } from './studio-web-tab'
import {
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  connectLineClient,
  startTestServer,
} from './studio-rpc.test-helper'

// What a web tab asks of the Studio that served it (`web-tab.ts`): every
// method an owner's, an owner's web tab included; refused to anyone else;
// offered only while the front door has handed its domain over; each asked as
// the asking browser, and the previews stream its own list. These replace the
// tab's tunnelled `web:browse-folders` and `web:previews:*` channels.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>

function stub() {
  const listeners = new Set<() => void>()
  const done: string[] = []
  let open: PreviewSummary[] = []
  const domain: StudioWebTabDomain = {
    browse: async (clientId, input) => {
      done.push(`browse:${clientId}:${input.path ?? '~'}`)
      return {
        ok: true,
        path: input.path ?? '/Users/dev',
        parent: null,
        home: '/Users/dev',
        entries: [],
        truncated: false,
      }
    },
    ports: async (clientId) => {
      done.push(`ports:${clientId}`)
      return { ports: [{ port: 5173, pid: 4242, command: 'vite' }] }
    },
    open: async (clientId, input) => {
      done.push(`open:${clientId}:${input.port}:${input.host}`)
      open = [{ previewId: 'p1', port: input.port, origin: 'http://127.0.0.1:61000', openedAt: 1, lastUsedAt: 1 }]
      listeners.forEach((listener) => listener())
      return { ok: true, previewId: 'p1', origin: 'http://127.0.0.1:61000', enterUrl: 'http://127.0.0.1:61000/enter' }
    },
    close: async (clientId, previewId) => {
      done.push(`close:${clientId}:${previewId}`)
      open = []
      listeners.forEach((listener) => listener())
      return true
    },
    previews: () => open,
    onPreviewsChanged: (listener) => {
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

const CALLS: Record<keyof typeof STUDIO_WEB_TAB_METHODS, Record<string, unknown>> = {
  'webFolders.browse': { path: '/Users/dev/projects' },
  'webPreviews.list': {},
  'webPreviews.open': { commandId: 'w1', port: 5173, host: 'localhost' },
  'webPreviews.close': { commandId: 'w2', previewId: 'p1' },
}

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_WEB_TAB_METHODS).sort())
})

test('an owner’s web tab reaches every method as itself, and a retry is the first answer', async () => {
  const { domain, done } = stub()
  const started = await startTestServer({ webTab: () => domain })
  cleanups.push(() => started.dispose())
  const tab = await attached(started.server, true)
  assert.ok((tab.welcome.capabilities as string[]).includes('web-tab'))
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, errorCode(await tab.request(method, params))], [method, null])
  await tab.request('webPreviews.open', CALLS['webPreviews.open'])
  const asking = done[0]?.split(':')[1]
  assert.ok(asking, 'each is asked as the browser that asked')
  assert.deepEqual(done, [
    `browse:${asking}:/Users/dev/projects`,
    `ports:${asking}`,
    `open:${asking}:5173:localhost`,
    `close:${asking}:p1`,
  ])
})

test('a preview names a loopback host the tab was opened on, and nothing else', async () => {
  const { domain, done } = stub()
  const started = await startTestServer({ webTab: () => domain })
  cleanups.push(() => started.dispose())
  const tab = await attached(started.server, true)
  for (const host of ['example.com', '0.0.0.0', undefined])
    assert.equal(
      errorCode(await tab.request('webPreviews.open', { commandId: `h-${String(host)}`, port: 5173, host })),
      'invalid_params',
    )
  assert.equal(
    errorCode(await tab.request('webPreviews.open', { commandId: 'p0', port: 0, host: '127.0.0.1' })),
    'invalid_params',
  )
  assert.deepEqual(done, [])
})

test('a paired app is refused every one, and the stream too', async () => {
  const { domain, done } = stub()
  const started = await startTestServer({ webTab: () => domain })
  cleanups.push(() => started.dispose())
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: pairFakeClient(started.auth, 'app', ['files:read', 'workspaces:operate']) }))
  await client.next((frame) => frame.t === 'welcome')
  let sequence = 0
  for (const [method, params] of Object.entries(CALLS)) {
    const id = `c${++sequence}`
    client.send({ t: 'req', id, method, params })
    const answer = await client.next((frame) => frame.t === 'res' && frame.id === id)
    assert.deepEqual([method, errorCode(answer)], [method, 'owner_required'])
  }
  client.send({ t: 'sub', id: 'sub1', topic: 'webPreviews.changed', params: {} })
  const refused = (await client.next((frame) => frame.t === 'subFailed')) as unknown as { code: string }
  assert.equal(refused.code, 'owner_required')
  assert.deepEqual(done, [])
})

test('the previews stream sends the list whole, and again on each change', async () => {
  const { domain } = stub()
  const started = await startTestServer({ webTab: () => domain })
  cleanups.push(() => started.dispose())
  const tab = await attached(started.server, true)
  const sub = tab.subscribe('webPreviews.changed')
  const first = await tab.until((frame) => frame.t === 'push' && frame.sub === sub)
  assert.deepEqual(first.payload, [])
  await tab.request('webPreviews.open', CALLS['webPreviews.open'])
  await tab.until(
    (frame) => frame.t === 'push' && frame.sub === sub && (frame.payload as PreviewSummary[]).length === 1,
  )
})

test('before the front door hands its domain over, and on a Studio with none, nothing is offered', async () => {
  let domain: StudioWebTabDomain | null = null
  const started = await startTestServer({ webTab: () => domain })
  cleanups.push(() => started.dispose())
  const before = await attached(started.server, true)
  assert.ok(!(before.welcome.capabilities as string[]).includes('web-tab'))
  assert.equal(errorCode(await before.request('webPreviews.list', {})), 'unavailable')
  domain = stub().domain
  const after = await attached(started.server, true)
  assert.ok((after.welcome.capabilities as string[]).includes('web-tab'))
})
