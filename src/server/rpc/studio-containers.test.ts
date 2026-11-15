import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { STUDIO_CONTAINERS_METHODS, type ContainerSummary } from '../../../packages/studio-protocol/src/public'
import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/scopes'
import type { StudioContainersDomain } from './studio-containers'
import type { StudioRpcAttachOptions } from './studio-rpc-server'
import {
  connectLineClient,
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// Chats' containers on the protocol (`containers.ts`): every method an
// owner's, Claude Code's token for them Studio's own desktop windows' only, a
// command carried out once per id, and a paired app refused all of it, whatever
// it holds. The domain is a stub; what it does on a host is ContainerChats'.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>
const SAVED_ID = '0123456789abcdef'

const LISTED: ContainerSummary[] = [
  {
    id: SAVED_ID,
    name: `sprintengine-${SAVED_ID}`,
    host: { kind: 'local' },
    hostLabel: 'this Mac',
    context: 'colima',
    status: 'Up 3 minutes',
    repo: {
      source: '/Users/dev/proj',
      path: '/home/node/work/proj',
      branch: 'studio/container-01234567',
      base: 'main',
    },
  },
]

function stub() {
  const done: Array<[string, unknown]> = []
  const listeners = new Set<() => void>()
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = {
    state: 'ready' as const,
    words: 'Docker 29.2.1 is running on this Mac (Colima).',
    imageReady: true,
    canStart: null,
  }
  const domain: StudioContainersDomain = {
    status: async (host) => (done.push(['status', host]), ready),
    startDocker: async (host) => (done.push(['startDocker', host]), ready),
    create: async (request, commandId) => {
      done.push(['create', request])
      done.push(['create id', commandId])
      // A first build takes minutes: held until the test lets it go.
      await held
      listeners.forEach((listener) => listener())
      return { ok: true, id: SAVED_ID, label: request.label, folder: '/home/node/work/proj' }
    },
    list: async () => (done.push(['list', null]), LISTED),
    push: async (id, commandId) => (done.push(['push', id], ['push id', commandId]), { ok: true, message: 'Pushed.' }),
    remove: async (target, commandId) => (done.push(['remove', target], ['remove id', commandId]), { ok: true }),
    tokenStatus: async () => (done.push(['tokenStatus', null]), { set: false, kept: null }),
    setToken: async (token) => (done.push(['setToken', token.length]), { ok: true }),
    clearToken: async () => (done.push(['clearToken', null]), { ok: true }),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { domain, done, release }
}

const CALLS: Record<keyof typeof STUDIO_CONTAINERS_METHODS, Record<string, unknown>> = {
  'containers.status': { host: { kind: 'local' } },
  'containers.startDocker': { commandId: 'k1', host: { kind: 'local' } },
  'containers.create': { commandId: 'k2', host: { kind: 'local' }, folder: '/Users/dev/proj', label: 'Fix it' },
  'containers.list': {},
  'containers.push': { commandId: 'k3', id: SAVED_ID },
  'containers.remove': { commandId: 'k4', id: SAVED_ID },
  'containers.tokenStatus': {},
  'containers.setToken': { commandId: 'k5', token: 'sk-ant-oat01-abc' },
  'containers.clearToken': { commandId: 'k6' },
}
// Every one: none is reached from a web tab or a script holding the owner's credential.
const WINDOW_ONLY = Object.keys(CALLS).sort()

/** A connection attached as main attaches it: a desktop window, or a script holding the owner's credential. */
async function attached(
  server: Awaited<ReturnType<typeof startTestServer>>['server'],
  options: Omit<StudioRpcAttachOptions, 'authenticator'>,
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
  toServer.write(`${JSON.stringify(hello({ token: OWNER_TOKEN }))}\n`)
  const welcome = await until((frame) => frame.t === 'welcome')
  let sequence = 0
  return {
    welcome,
    until,
    send(method: string, params: Record<string, unknown>) {
      const id = `a${++sequence}`
      toServer.write(`${JSON.stringify({ t: 'req', id, method, params })}\n`)
      return id
    },
    async request(method: string, params: Record<string, unknown>) {
      const id = this.send(method, params)
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

async function serve(withDomain = true) {
  const domain = stub()
  const started = await startTestServer(withDomain ? { containers: domain.domain } : {})
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

test('every method of the family has a call here, and every one is Studio’s own windows’', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_CONTAINERS_METHODS).sort())
  assert.deepEqual(
    Object.keys(CALLS)
      .filter((method) => STUDIO_CONTAINERS_METHODS[method as keyof typeof CALLS].window !== undefined)
      .sort(),
    WINDOW_ONLY,
  )
})

test("a desktop's Studio that makes containers advertises them, and one that does not, does not", async () => {
  const { started, release } = await serve()
  release()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  assert.ok((window.welcome.capabilities as string[]).includes('containers'))
  const { started: without } = await serve(false)
  const bare = await attached(without.server, { ownWindow: true, windowKey: 'w1' })
  assert.equal((bare.welcome.capabilities as string[]).includes('containers'), false)
  assert.equal(errorCode(await bare.request('containers.list', {})), 'unavailable')
})

test('Studio’s own desktop window reaches every method, the list whole, and a retried create makes one container', async () => {
  const { started, done, release } = await serve()
  const window = await attached(started.server, { ownWindow: true, windowKey: 'w1' })
  const sub = window.subscribe('containers.changed')
  // A create asked twice under one id (a reconnect mid-build) is one container.
  const first = window.send('containers.create', CALLS['containers.create'])
  const again = window.send('containers.create', CALLS['containers.create'])
  release()
  const [one, two] = await Promise.all([
    window.until((frame) => frame.t === 'res' && frame.id === first),
    window.until((frame) => frame.t === 'res' && frame.id === again),
  ])
  assert.deepEqual(one.result, { ok: true, id: SAVED_ID, label: 'Fix it', folder: '/home/node/work/proj' })
  assert.deepEqual(two.result, one.result)
  assert.equal(done.filter(([name]) => name === 'create').length, 1)
  // The client's id goes on to main, namespaced as every receipt is, so main
  // answers it again after this server restarted.
  assert.deepEqual(
    done.find(([name]) => name === 'create id'),
    ['create id', 'owner:k2'],
  )
  assert.deepEqual(done.find(([name]) => name === 'create')?.[1], {
    host: { kind: 'local' },
    folder: '/Users/dev/proj',
    label: 'Fix it',
    image: { kind: 'studio-default' },
  })
  // Made: the stream says so, and carries nothing.
  const pushed = await window.until((frame) => frame.t === 'push' && frame.sub === sub)
  assert.deepEqual(pushed.payload, {})
  for (const [method, params] of Object.entries(CALLS)) {
    if (method === 'containers.create') continue
    const answer = await window.request(method, params)
    assert.equal(answer.ok, true, `${method}: ${JSON.stringify(answer)}`)
  }
  const listed = await window.request('containers.list', {})
  assert.deepEqual(listed.result, { containers: LISTED })
  assert.deepEqual(
    done.find(([name]) => name === 'push id'),
    ['push id', 'owner:k3'],
  )
  assert.deepEqual(
    done.find(([name]) => name === 'remove id'),
    ['remove id', 'owner:k4'],
  )
  // The token went to the domain; its words never come back.
  assert.deepEqual(
    done.find(([name]) => name === 'setToken'),
    ['setToken', 'sk-ant-oat01-abc'.length],
  )
})

test("an owner's web tab and a script holding the owner's credential are refused every method and the stream", async () => {
  const { started, done, release } = await serve()
  release()
  // A browser tab of the owner's (the web client), and an app or script on the owner socket.
  for (const options of [{ ownWindow: false, browser: true }, { ownWindow: false }]) {
    const other = await attached(started.server, options)
    for (const method of WINDOW_ONLY) {
      const answer = await other.request(method, CALLS[method as keyof typeof CALLS])
      assert.equal(errorCode(answer), 'owner_required', `${JSON.stringify(options)} ${method}`)
    }
    const sub = other.subscribe('containers.changed')
    const failed = await other.until((frame) => frame.t === 'subFailed' && frame.sub === sub)
    assert.equal(failed.code, 'owner_required')
  }
  assert.deepEqual(done, [])
})

test('a paired app is refused every method and the stream, whatever it holds, and nothing reaches Docker', async () => {
  const { started, done, release } = await serve()
  release()
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  // Every scope there is: making one starts a chat on a machine a device does not reach.
  app.send(hello({ token: pairFakeClient(started.auth, 'app', [...STUDIO_SCOPES]) }))
  await app.next((frame) => frame.t === 'welcome')
  let sequence = 0
  for (const [method, params] of Object.entries(CALLS)) {
    const id = `p${++sequence}`
    app.send({ t: 'req', id, method, params })
    const answer = await app.next((frame) => frame.t === 'res' && frame.id === id)
    assert.equal(errorCode(answer), 'owner_required', method)
    assert.match(String((answer as { error?: { message?: string } }).error?.message), /own connections/u, method)
  }
  app.send({ t: 'sub', id: 's0', topic: 'containers.changed', params: {} })
  const failed = await app.next((frame) => frame.t === 'subFailed' && frame.sub === 's0')
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
  assert.deepEqual(done, [])
})
