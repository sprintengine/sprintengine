import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { STUDIO_ACCESS_METHODS, type StudioLocalAppsStatus } from '../../../packages/studio-protocol/src/public'
import type { StudioAccessDomain } from './studio-access'
import type { StudioRpcAttachOptions } from './studio-rpc-server'
import {
  connectLineClient,
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// Who may reach this machine's agents (`access.ts`): every method an owner's,
// and minting an HTTP token or anything of local app pairing served to
// Studio's own desktop windows only. An owner's web tab, a script holding the
// owner's credential and the shell are refused those; a paired app is refused
// every one. No answer to anyone else carries a token or a code.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>

const TOKEN = 'semcp_secret-token'
const CODE = 'pair-code-123456'

function stub() {
  const listeners = new Set<(status: StudioLocalAppsStatus) => void>()
  let apps: StudioLocalAppsStatus = { running: true, socketPath: '/run/s.sock', lastError: null, apps: [], offers: [] }
  const minted: string[] = []
  const mcpStatus = { running: true, url: 'http://127.0.0.1:1/mcp', clients: [], lastError: null }
  const announce = () => listeners.forEach((listener) => listener(apps))
  const access: StudioAccessDomain = {
    gatewayStatus: () => ({
      enabled: true,
      running: true,
      socketPath: '/run/g.sock',
      lastError: null,
      bridgeScriptPath: null,
    }),
    mcpHttpStatus: () => mcpStatus,
    createMcpHttp: async (name) => {
      minted.push(`mcp:${name}`)
      return {
        ok: true,
        status: mcpStatus,
        client: { id: 'c1', name, createdAt: 1, lastUsedAt: null },
        token: TOKEN,
        url: mcpStatus.url,
      }
    },
    revokeMcpHttp: async () => mcpStatus,
    localApps: {
      status: () => apps,
      offer: (input) => {
        minted.push(`app:${input.name}`)
        const offer = { id: 'o1', ...input, expiresAt: '2030-01-01T00:00:00.000Z' }
        apps = { ...apps, offers: [offer] }
        announce()
        return { offer, code: CODE, status: apps }
      },
      cancelOffer: () => {
        apps = { ...apps, offers: [] }
        announce()
        return apps
      },
      revoke: async () => apps,
      setReach: () => apps,
      onChanged: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
  }
  return { access, minted }
}

/** A connection attached as main attaches it: a desktop window, a web tab, the shell. */
async function attached(
  server: Awaited<ReturnType<typeof startTestServer>>['server'],
  options: Omit<StudioRpcAttachOptions, 'authenticator'>,
  token = OWNER_TOKEN,
) {
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
  server.attach(serverSide, { authenticator: createFakeAuthenticator(), ...options })
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
  toServer.write(`${JSON.stringify(hello({ token }))}\n`)
  const welcome = await until((frame) => frame.t === 'welcome')
  let sequence = 0
  return {
    welcome,
    frames,
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

async function lineClient(path: string, token: string) {
  const client = await connectLineClient(path)
  cleanups.push(() => client.close())
  client.send(hello({ token }))
  await client.next((frame) => frame.t === 'welcome')
  let sequence = 0
  return {
    async request(method: string, params: Record<string, unknown>): Promise<Frame> {
      const id = `c${++sequence}`
      client.send({ t: 'req', id, method, params })
      return (await client.next((frame) => frame.t === 'res' && frame.id === id)) as unknown as Frame
    },
  }
}

const errorCode = (answer: unknown) => (answer as { error?: { code?: string } }).error?.code ?? null

const CALLS: Record<keyof typeof STUDIO_ACCESS_METHODS, Record<string, unknown>> = {
  'gateway.status': {},
  'mcpHttp.status': {},
  'mcpHttp.create': { commandId: 'm1', name: 'editor' },
  'mcpHttp.revoke': { commandId: 'm2', id: 'c1' },
  'localApps.status': {},
  'localApps.offer': {
    commandId: 'l1',
    input: { name: 'app', scopes: ['conversation:read'], ceiling: 'manual', toolReach: 'own' },
  },
  'localApps.cancelOffer': { commandId: 'l2', id: 'o1' },
  'localApps.revoke': { commandId: 'l3', id: 'a1' },
  'localApps.setReach': { commandId: 'l4', id: 'a1', reach: 'all' },
}
const WINDOW_ONLY = Object.keys(CALLS).filter(
  (method) => STUDIO_ACCESS_METHODS[method as keyof typeof CALLS].window !== undefined,
)

async function serve() {
  const domain = stub()
  const started = await startTestServer({ access: domain.access })
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

test('every method of the family has a call here, and the window-only ones are the minting and pairing', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_ACCESS_METHODS).sort())
  assert.deepEqual(WINDOW_ONLY.sort(), [
    'localApps.cancelOffer',
    'localApps.offer',
    'localApps.revoke',
    'localApps.setReach',
    'localApps.status',
    'mcpHttp.create',
  ])
})

test('Studio’s own desktop window reaches every method, and a retried mint is the first one', async () => {
  const { started, minted } = await serve()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  assert.ok((window.welcome.capabilities as string[]).includes('access'))
  for (const [method, params] of Object.entries(CALLS)) {
    const answer = await window.request(method, params)
    assert.deepEqual([method, errorCode(answer)], [method, null])
  }
  const made = await window.request('mcpHttp.create', CALLS['mcpHttp.create'])
  assert.equal((made.result as { token: string }).token, TOKEN)
  assert.deepEqual(minted, ['mcp:editor', 'app:app'], 'a retry under the same command id mints nothing more')
})

test('an owner’s web tab, an owner on the socket and the shell are refused what mints or pairs; a paired app all of it', async () => {
  const { started, minted } = await serve()
  const tab = await attached(started.server, { ownWindow: true, browser: true, audited: true })
  const shell = await attached(started.server, { ownWindow: false, shell: true })
  // A window's flag without a window's ticket is not a window.
  const unticketed = await attached(started.server, { ownWindow: true })
  const owner = await lineClient(started.path, OWNER_TOKEN)
  for (const caller of [tab, shell, unticketed, owner]) {
    for (const [method, params] of Object.entries(CALLS)) {
      const answer = await caller.request(method, params)
      const expected = WINDOW_ONLY.includes(method) ? 'owner_required' : null
      assert.deepEqual([method, errorCode(answer)], [method, expected])
      assert.equal(JSON.stringify(answer).includes(TOKEN), false, `${method} answers no token`)
      assert.equal(JSON.stringify(answer).includes(CODE), false, `${method} answers no code`)
    }
  }
  const paired = await lineClient(
    started.path,
    pairFakeClient(started.auth, 'app', ['conversation:read', 'settings:write', 'workspaces:operate']),
  )
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, errorCode(await paired.request(method, params))], [method, 'owner_required'])
  assert.deepEqual(minted, [])
})

test('the paired apps stream reaches a window, whole at once and on every change, and no other client', async () => {
  const { started } = await serve()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  const tab = await attached(started.server, { ownWindow: true, browser: true })
  const followed = window.subscribe('localApps.changed')
  const refused = tab.subscribe('localApps.changed')
  await window.until((frame) => frame.t === 'push' && frame.sub === followed)
  assert.equal(
    ((await tab.until((frame) => frame.t === 'subFailed' && frame.sub === refused)) as { code?: string }).code,
    'owner_required',
  )
  await window.request('localApps.offer', CALLS['localApps.offer'])
  const pushed = await window.until(
    (frame) =>
      frame.t === 'push' &&
      frame.sub === followed &&
      (frame.payload as StudioLocalAppsStatus).offers.some((offer) => offer.id === 'o1'),
  )
  assert.equal(JSON.stringify(pushed).includes(CODE), false, 'the stream never carries a code')
})

test('a Studio given no access domain offers no access and answers it unavailable', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  assert.ok(!(window.welcome.capabilities as string[]).includes('access'))
  assert.equal(errorCode(await window.request('gateway.status', {})), 'unavailable')
})
