import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { SignIns } from '../machine/machine-sign-in'
import {
  connectLineClient,
  createFakeAuthenticator,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// What the desktop that holds a machine's Studio asks of it
// (`environment-access.ts`): a ticket for one of its windows, asked by its
// shell connection alone, and a CLI's sign-in with no terminal, an owner's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = Record<string, unknown>

/** A connection the server is told is the desktop's shell (`connectShellStream`), saying hello as the owner. */
async function shellOf(server: Awaited<ReturnType<typeof startTestServer>>['server']) {
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
  server.attach(serverSide, { authenticator: createFakeAuthenticator(), ownWindow: false, shell: true })
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
  toServer.write(`${JSON.stringify(hello({ token: OWNER_TOKEN }, { client: { name: 'SprintEngine Studio' } }))}\n`)
  const welcome = await until((frame) => frame.t === 'welcome')
  let sequence = 0
  return {
    welcome,
    async request(method: string, params: Record<string, unknown>) {
      const id = `s${++sequence}`
      toServer.write(`${JSON.stringify({ t: 'req', id, method, params })}\n`)
      return until((frame) => frame.t === 'res' && frame.id === id)
    },
  }
}

/** A line client on the owner socket: an owner, but not the desktop's shell. */
async function lineClient(path: string, token: string) {
  const client = await connectLineClient(path)
  cleanups.push(() => client.close())
  client.send(hello({ token }))
  const welcome = (await client.next((frame) => frame.t === 'welcome')) as unknown as Frame
  let sequence = 0
  return {
    welcome,
    async request(method: string, params: Record<string, unknown>): Promise<Frame> {
      const id = `c${++sequence}`
      client.send({ t: 'req', id, method, params })
      return (await client.next((frame) => frame.t === 'res' && frame.id === id)) as unknown as Frame
    },
  }
}

const errorCode = (answer: unknown) => (answer as { error?: { code?: string } }).error?.code ?? null

test('only the shell that holds this Studio is given a ticket for one of its windows', async () => {
  const asked: Array<{ windowKey: string; origin: string }> = []
  const started = await startTestServer({
    environmentAccess: {
      windowTicket: async (request) => {
        asked.push(request)
        return { token: 'ticket-1', path: '/ws?ticket=ticket-1' }
      },
      revokeWindow: () => undefined,
      deviceTicket: async () => ({ token: 'device-1', path: '/device?ticket=device-1' }),
    },
  })
  cleanups.push(() => started.dispose())

  const shell = await shellOf(started.server)
  assert.ok((shell.welcome.capabilities as string[]).includes('window-tickets'))
  const minted = await shell.request('environment.windowTicket', { windowKey: 'w1', origin: 'file://' })
  assert.deepEqual(minted.result, { token: 'ticket-1', path: '/ws?ticket=ticket-1' })
  assert.deepEqual(asked, [{ windowKey: 'w1', origin: 'file://' }])

  // An owner on the socket is the owner, but not the desktop's shell.
  const owner = await lineClient(started.path, OWNER_TOKEN)
  assert.equal(
    errorCode(await owner.request('environment.windowTicket', { windowKey: 'w2', origin: 'file://' })),
    'owner_required',
  )
  // A paired app, whatever it was granted, is not an owner at all.
  const paired = await lineClient(
    started.path,
    pairFakeClient(started.auth, 'chat-app', ['conversation:read', 'conversation:operate', 'settings:write']),
  )
  assert.equal(
    errorCode(await paired.request('environment.windowTicket', { windowKey: 'w3', origin: 'file://' })),
    'owner_required',
  )
  assert.equal(asked.length, 1)

  assert.equal(
    errorCode(await shell.request('environment.windowTicket', { windowKey: '', origin: 'file://' })),
    'invalid_params',
  )
})

test('a Studio no desktop holds over its front door offers no window tickets', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const shell = await shellOf(started.server)
  assert.ok(!(shell.welcome.capabilities as string[]).includes('window-tickets'))
  assert.equal(
    errorCode(await shell.request('environment.windowTicket', { windowKey: 'w1', origin: 'file://' })),
    'unavailable',
  )
})

/** A sign-in table that records its steps; `wait` ends when told. */
function fakeSignIns() {
  const steps: string[] = []
  let finish: (done: { ok: true }) => void = () => undefined
  const table = {
    async start(cli: string) {
      steps.push(`start ${cli}`)
      return { ok: true as const, id: 'login-1', url: 'https://example.test/device', code: 'ABCD-1234', paste: false }
    },
    paste(id: string, code: string) {
      steps.push(`paste ${id} ${code}`)
      return { ok: true }
    },
    wait(id: string) {
      steps.push(`wait ${id}`)
      return new Promise<{ ok: true }>((resolve) => (finish = resolve))
    },
    cancel(id: string) {
      steps.push(`cancel ${id}`)
    },
    stopAll() {},
  } as unknown as SignIns
  return { steps, table, finish: () => finish({ ok: true }) }
}

test('a CLI is signed in on the machine by its provider, one step per command id, and only by an owner', async () => {
  const signIns = fakeSignIns()
  const started = await startTestServer({ signIns: async () => signIns.table })
  cleanups.push(() => started.dispose())
  const owner = await lineClient(started.path, OWNER_TOKEN)
  assert.ok((owner.welcome.capabilities as string[]).includes('provider-sign-in-flow'))
  const codex = conversationProviderForCli('codex')!

  const begun = await owner.request('providers.signInStart', { commandId: 'c-start', providerId: codex })
  assert.deepEqual(begun.result, {
    ok: true,
    id: 'login-1',
    url: 'https://example.test/device',
    code: 'ABCD-1234',
    paste: false,
  })
  // The same command again is the same login, not a second one.
  const again = await owner.request('providers.signInStart', { commandId: 'c-start', providerId: codex })
  assert.deepEqual(again.result, begun.result)

  const waiting = owner.request('providers.signInWait', { commandId: 'c-wait', id: 'login-1' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  signIns.finish()
  assert.deepEqual((await waiting).result, { ok: true })
  assert.deepEqual((await owner.request('providers.signInCancel', { commandId: 'c-cancel', id: 'login-1' })).result, {
    ok: true,
  })
  assert.deepEqual(signIns.steps, ['start codex', 'wait login-1', 'cancel login-1'])

  // A provider with no CLI is told so, and nothing runs.
  const none = await owner.request('providers.signInStart', { commandId: 'c-none', providerId: 'no-such-provider' })
  assert.equal((none.result as { ok: boolean }).ok, false)
  assert.equal(signIns.steps.length, 3)

  // A paired app that may change settings is still not an owner.
  const paired = await lineClient(started.path, pairFakeClient(started.auth, 'settings-app', ['settings:write']))
  assert.equal(
    errorCode(await paired.request('providers.signInStart', { commandId: 'p-start', providerId: codex })),
    'owner_required',
  )
  assert.equal(signIns.steps.length, 3)
})

test('a Studio with a terminal beside it offers no sign-in without one', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const owner = await lineClient(started.path, OWNER_TOKEN)
  assert.ok(!(owner.welcome.capabilities as string[]).includes('provider-sign-in-flow'))
  assert.equal(
    errorCode(await owner.request('providers.signInStart', { commandId: 'c1', providerId: 'codex' })),
    'unavailable',
  )
})

test('a window is revoked and a device ticket minted only for the shell, a device never beyond the relayed ceiling', async () => {
  const revoked: string[] = []
  const devices: unknown[] = []
  const started = await startTestServer({
    environmentAccess: {
      windowTicket: async () => ({ token: 't', path: '/ws?ticket=t' }),
      revokeWindow: (windowKey) => revoked.push(windowKey),
      deviceTicket: async (request) => {
        devices.push(request)
        return { token: 'd', path: '/device?ticket=d' }
      },
    },
  })
  cleanups.push(() => started.dispose())
  const shell = await shellOf(started.server)
  assert.ok((shell.welcome.capabilities as string[]).includes('device-tickets'))

  assert.deepEqual((await shell.request('environment.revokeWindow', { windowKey: 'window-3-2' })).result, {
    revoked: true,
  })
  assert.deepEqual(revoked, ['window-3-2'])

  const minted = await shell.request('environment.deviceTicket', {
    deviceId: 'phone-1',
    name: 'Phone',
    scopes: ['conversation:operate', 'conversation:read'],
  })
  assert.deepEqual(minted.result, { token: 'd', path: '/device?ticket=d' })
  // Held in the ceiling's order, whatever order they were named in.
  assert.deepEqual(devices, [
    { deviceId: 'phone-1', name: 'Phone', scopes: ['conversation:read', 'conversation:operate'] },
  ])

  // Beyond the ceiling is refused at minting: no files, no settings, no terminals by any name.
  for (const scopes of [['files:read'], ['conversation:read', 'settings:write'], ['environment:maintain'], []])
    assert.equal(
      errorCode(await shell.request('environment.deviceTicket', { deviceId: 'phone-1', name: 'Phone', scopes })),
      'invalid_params',
      JSON.stringify(scopes),
    )
  assert.equal(devices.length, 1)

  const owner = await lineClient(started.path, OWNER_TOKEN)
  assert.equal(
    errorCode(await owner.request('environment.revokeWindow', { windowKey: 'window-3-2' })),
    'owner_required',
  )
  assert.equal(
    errorCode(
      await owner.request('environment.deviceTicket', {
        deviceId: 'phone-1',
        name: 'Phone',
        scopes: ['conversation:read'],
      }),
    ),
    'owner_required',
  )
  assert.equal(revoked.length, 1)
  assert.equal(devices.length, 1)
})

test('a hand-over is the shell’s alone, answered once per command id', async () => {
  const handed: unknown[] = []
  const started = await startTestServer({
    adoption: {
      adopt: async (input) => {
        handed.push(input)
        return { held: input.records.map((entry) => ({ kind: entry.kind, id: entry.id })), conflicts: [] }
      },
    },
  })
  cleanups.push(() => started.dispose())
  const shell = await shellOf(started.server)
  assert.ok((shell.welcome.capabilities as string[]).includes('environment-adopt'))
  const records = [{ kind: 'workspace', id: 'ws-1', digest: 'a'.repeat(64), body: { id: 'ws-1' } }]
  const first = await shell.request('environment.adopt', { commandId: 'h-1', migrationId: 'm-1', records })
  assert.deepEqual(first.result, { held: [{ kind: 'workspace', id: 'ws-1' }], conflicts: [] })
  await shell.request('environment.adopt', { commandId: 'h-1', migrationId: 'm-1', records })
  assert.equal(handed.length, 1, 'the same command is answered from its receipt')
  assert.equal(
    errorCode(
      await shell.request('environment.adopt', {
        commandId: 'h-2',
        migrationId: 'm-1',
        records: [{ kind: 'terminal', id: 't', digest: 'a'.repeat(64), body: {} }],
      }),
    ),
    'invalid_params',
  )
  const owner = await lineClient(started.path, OWNER_TOKEN)
  assert.equal(
    errorCode(await owner.request('environment.adopt', { commandId: 'h-3', migrationId: 'm-1', records })),
    'owner_required',
  )
  assert.equal(handed.length, 1)
})
