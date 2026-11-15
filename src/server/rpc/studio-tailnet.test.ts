import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import {
  STUDIO_TAILNET_METHODS,
  STUDIO_TAILNET_TOPICS,
  type MeshEvent,
  type TailnetPushPayload,
  type TailnetRemoteStatus,
} from '../../../packages/studio-protocol/src/public'
import type { StudioTailnetDomain, TailnetAnswerVia } from './studio-tailnet'
import { createStudioTailnetDomain } from '../core/studio-rpc'
import type { StudioGateway } from '../core/studio-gateway'
import type { TailnetShareService } from '../../main/automation/tailnet/tailnet-share-service'
import type { StudioRpcAttachOptions } from './studio-rpc-server'
import {
  connectLineClient,
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// Who reaches this machine over the tailnet, and the machines it drives
// (`tailnet.ts`): every method and both streams an owner's, and what lets
// someone in or answers a code served to Studio's own desktop windows only.
// An owner's web tab, a script holding the owner's credential and the shell
// are refused those and may read and narrow; a paired app is refused all.
// No answer to anyone but a window carries a pairing code.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>

const CODE = 'pair-token-123456'
const COMPARISON = '481972'

function stub() {
  const tailnetListeners = new Set<(payload: TailnetPushPayload) => void>()
  const meshListeners = new Set<(event: MeshEvent) => void>()
  const done: string[] = []
  const denied: TailnetAnswerVia[] = []
  let revision = 3
  const status = (): TailnetRemoteStatus => ({
    enabled: true,
    running: true,
    endpoint: '100.64.0.1:7777',
    port: 7777,
    tailnetAddress: '100.64.0.1',
    lastError: null,
    notifications: true,
    devices: [],
    pairing: null,
    pairRequests: [],
  })
  const live = () => ({ revision, devices: [] })
  const request = {
    requestId: 'r1',
    endpoint: '100.64.0.2:7777',
    machineName: 'build-box',
    comparisonCode: COMPARISON,
    expiresAt: '2030-01-01T00:00:00.000Z',
    reverseOffered: false,
  }
  const shares = { available: true, dnsName: 'mac-mini.tail1234.ts.net', shares: [], ladderFull: false }
  const did = <T>(name: string, value: T): T => {
    done.push(name)
    return value
  }
  const tailnet: StudioTailnetDomain = {
    status,
    liveState: live,
    setEnabled: async () => did('setEnabled', status()),
    setHttps: async () => did('setHttps', status()),
    offerPairing: (scopes) => {
      done.push('offerPairing')
      revision += 1
      const payload: TailnetPushPayload = {
        revision,
        event: { kind: 'devices-changed' },
        status: status(),
        live: live(),
      }
      tailnetListeners.forEach((listener) => listener(payload))
      return { token: CODE, scopes: scopes ?? [], expiresAt: '2030-01-01T00:00:00.000Z', pairingUrl: null }
    },
    cancelPairing: () => did('cancelPairing', status()),
    approvePairRequest: () =>
      did('approvePairRequest', { ok: false, code: 'request_not_found', message: 'gone', status: status() }),
    denyPairRequest: (_id, via) => {
      denied.push(via)
      return did('denyPairRequest', status())
    },
    revokeDevice: () => did('revokeDevice', status()),
    updateDeviceScopes: () => did('updateDeviceScopes', status()),
    forgetMachine: () =>
      did('forgetMachine', { connections: [], revokedDeviceId: null, forgottenConnectionId: null, status: status() }),
    resetMcpRegistrations: () => did('resetMcpRegistrations', status()),
    peers: async () => ({ tailscaleAvailable: true, unavailableReason: null, probedPort: 7777, peers: [] }),
    shares: async () => shares,
    share: async () => did('share', { ok: true, share: null, status: shares }),
    unshare: async () => did('unshare', { ok: true, share: null, status: shares }),
    onChanged: (listener) => {
      tailnetListeners.add(listener)
      return () => void tailnetListeners.delete(listener)
    },
    mesh: {
      connections: () => [],
      liveState: () => ({ revision: 1, requests: [request], reachability: [] }),
      pair: async () => did('mesh.pair', { ok: false, code: 'bad_link', message: 'no' }),
      requestPairing: async () => did('mesh.requestPairing', { ok: true, request }),
      cancelPairing: () => void done.push('mesh.cancelPairing'),
      forget: () => did('mesh.forget', []),
      onChanged: (listener) => {
        meshListeners.add(listener)
        return () => void meshListeners.delete(listener)
      },
    },
  }
  return { tailnet, done, denied }
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

const CALLS: Record<keyof typeof STUDIO_TAILNET_METHODS, Record<string, unknown>> = {
  'tailnet.status': {},
  'tailnet.liveState': {},
  'tailnet.setEnabled': { commandId: 't1', enabled: true },
  'tailnet.setHttps': { commandId: 't2', enabled: false },
  'tailnet.offerPairing': { commandId: 't3', scopes: ['conversation:read'] },
  'tailnet.cancelPairing': { commandId: 't4' },
  'tailnet.approvePairRequest': { commandId: 't5', id: 'q1', scopes: ['conversation:read'], code: '123456' },
  'tailnet.denyPairRequest': { commandId: 't6', id: 'q1' },
  'tailnet.revokeDevice': { commandId: 't7', id: 'd1' },
  'tailnet.updateDeviceScopes': { commandId: 't8', id: 'd1', scopes: ['workspace:read'] },
  'tailnet.forgetMachine': { commandId: 't9', deviceId: 'd1' },
  'tailnet.resetMcpRegistrations': { commandId: 't10' },
  'tailnet.peers': {},
  'tailnet.shares': {},
  'tailnet.share': { commandId: 't11', localPort: 5173 },
  'tailnet.unshare': { commandId: 't12', servePort: 8443 },
  'mesh.connections': {},
  'mesh.liveState': {},
  'mesh.pair': { commandId: 'm1', pairingUrl: 'http://100.64.0.2:7777/pair#x' },
  'mesh.requestPairing': { commandId: 'm2', endpoint: '100.64.0.2:7777' },
  'mesh.cancelPairing': { commandId: 'm3', requestId: 'r1' },
  'mesh.forget': { commandId: 'm4', connectionId: 'c1' },
}
const WINDOW_ONLY = Object.keys(CALLS).filter(
  (method) => STUDIO_TAILNET_METHODS[method as keyof typeof CALLS].window !== undefined,
)

async function serve() {
  const domain = stub()
  const started = await startTestServer({ tailnet: domain.tailnet })
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

test('every method of the family has a call here, and the window-only ones let someone in or answer a code', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_TAILNET_METHODS).sort())
  assert.deepEqual(WINDOW_ONLY.sort(), [
    'mesh.liveState',
    'mesh.pair',
    'mesh.requestPairing',
    'tailnet.approvePairRequest',
    'tailnet.offerPairing',
    'tailnet.peers',
    'tailnet.setEnabled',
    'tailnet.setHttps',
    'tailnet.share',
    'tailnet.updateDeviceScopes',
  ])
  assert.equal(STUDIO_TAILNET_TOPICS['tailnet.changed'].window, undefined)
  assert.ok(STUDIO_TAILNET_TOPICS['mesh.changed'].window)
})

test('Studio’s own desktop window reaches every method, a retried offer is the first one, and its decline is audited by the service', async () => {
  const { started, done, denied } = await serve()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  assert.ok((window.welcome.capabilities as string[]).includes('tailnet'))
  for (const [method, params] of Object.entries(CALLS)) {
    const answer = await window.request(method, params)
    assert.deepEqual([method, errorCode(answer)], [method, null])
  }
  const offered = await window.request('tailnet.offerPairing', CALLS['tailnet.offerPairing'])
  assert.equal((offered.result as { token: string }).token, CODE)
  assert.equal(
    done.filter((name) => name === 'offerPairing').length,
    1,
    'a retry under the same command id mints nothing more',
  )
  assert.deepEqual(denied, ['window'])
})

test('an owner’s web tab, an owner on the socket and the shell read and narrow but are refused what lets someone in; a paired app all of it', async () => {
  const { started, done, denied } = await serve()
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
      assert.equal(JSON.stringify(answer).includes(CODE), false, `${method} answers no pairing code`)
      assert.equal(JSON.stringify(answer).includes(COMPARISON), false, `${method} answers no request's code`)
    }
  }
  const lettingIn = [
    'setEnabled',
    'setHttps',
    'offerPairing',
    'approvePairRequest',
    'updateDeviceScopes',
    'share',
    'mesh.pair',
    'mesh.requestPairing',
  ]
  assert.deepEqual(
    done.filter((name) => lettingIn.includes(name)),
    [],
  )
  // A decline the router already audited is not audited again by the service.
  assert.ok(denied.length > 0 && denied.every((via) => via === 'tool'))
  const paired = await lineClient(
    started.path,
    pairFakeClient(started.auth, 'app', ['conversation:read', 'settings:write', 'workspaces:operate']),
  )
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, errorCode(await paired.request(method, params))], [method, 'owner_required'])
})

test('the listener’s stream reaches an owner’s tab as it stands and on each change; the mesh’s reaches a window only', async () => {
  const { started } = await serve()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  const tab = await attached(started.server, { ownWindow: true, browser: true, audited: true })
  const listener = tab.subscribe('tailnet.changed')
  const first = await tab.until((frame) => frame.t === 'push' && frame.sub === listener)
  assert.deepEqual((first.payload as TailnetPushPayload).event, { kind: 'current' })
  await window.request('tailnet.offerPairing', CALLS['tailnet.offerPairing'])
  const changed = await tab.until(
    (frame) =>
      frame.t === 'push' &&
      frame.sub === listener &&
      (frame.payload as TailnetPushPayload).event.kind === 'devices-changed',
  )
  assert.equal(JSON.stringify(changed).includes(CODE), false, 'the stream never carries the code')

  const mesh = window.subscribe('mesh.changed')
  const current = await window.until((frame) => frame.t === 'push' && frame.sub === mesh)
  assert.equal((current.payload as MeshEvent).kind, 'current')
  const refused = tab.subscribe('mesh.changed')
  assert.equal(
    ((await tab.until((frame) => frame.t === 'subFailed' && frame.sub === refused)) as { code?: string }).code,
    'owner_required',
  )
})

test('a Studio given no tailnet domain offers no tailnet and answers it unavailable', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  assert.ok(!(window.welcome.capabilities as string[]).includes('tailnet'))
  assert.equal(errorCode(await window.request('tailnet.status', {})), 'unavailable')
})

test('the server’s composition answers a window’s approval as the window’s, the one door that may let an MCP client sign in', async () => {
  // `createStudioRpc` wires the family to the gateway. The device store lets
  // an MCP client's OAuth sign-in in only on an answer that came `via:
  // 'window'` (tailnet-oauth.test.ts); this holds the composition to passing
  // exactly that for the window-only approve, and nothing for anyone else.
  const { tailnet } = stub()
  const approvals: Array<{ id: string; via?: string }> = []
  const declines: Array<string | undefined> = []
  const gateway = {
    approveTailnetPairRequest: (input: { id: string; via?: string }) => {
      approvals.push({ id: input.id, ...(input.via !== undefined ? { via: input.via } : {}) })
      return { ok: false, code: 'request_not_found', message: 'gone', status: tailnet.status() }
    },
    denyTailnetPairRequest: (_id: string, via?: string) => {
      declines.push(via)
      return tailnet.status()
    },
    getTailnetStatus: () => tailnet.status(),
    getTailnetLiveState: () => tailnet.liveState(),
    onTailnetChanged: (listener: (payload: TailnetPushPayload) => void) => tailnet.onChanged(listener),
    onMeshChanged: (listener: (event: MeshEvent) => void) => tailnet.mesh.onChanged(listener),
    mesh: () => ({ getLiveState: () => tailnet.mesh.liveState(), listConnections: () => [] }),
  } as unknown as StudioGateway
  const domain = createStudioTailnetDomain(gateway, {} as TailnetShareService)
  const started = await startTestServer({ tailnet: domain })
  cleanups.push(() => started.dispose())

  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  const tab = await attached(started.server, { ownWindow: true, browser: true, audited: true })
  const owner = await lineClient(started.path, OWNER_TOKEN)
  for (const caller of [tab, owner])
    assert.equal(
      errorCode(await caller.request('tailnet.approvePairRequest', CALLS['tailnet.approvePairRequest'])),
      'owner_required',
    )
  assert.deepEqual(approvals, [], 'a refused approval never reaches the gateway')

  assert.equal(errorCode(await window.request('tailnet.approvePairRequest', CALLS['tailnet.approvePairRequest'])), null)
  assert.deepEqual(approvals, [{ id: 'q1', via: 'window' }])

  // A decline keeps the door it came through, so it is audited once.
  await window.request('tailnet.denyPairRequest', { commandId: 'd1', id: 'q1' })
  await tab.request('tailnet.denyPairRequest', { commandId: 'd2', id: 'q1' })
  assert.deepEqual(declines, ['window', 'tool'])
})
