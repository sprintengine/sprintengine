import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import { conversationProviderForCli } from '../../../shared/conversation-harness'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, SSH_ENV_CHANNELS } from '../../../shared/ssh-environments'
import { redactDiagnostics, SshEnvironments } from './ssh-environments'

// The desktop's saved SSH machines: added only once `ssh -G` makes sense of
// them, kept with no credential, and their prompts shown in every window,
// the first answer winning. `ssh -G` connects to nothing, so this runs
// anywhere OpenSSH is installed.

const HAS_SSH = spawnSync('ssh', ['-V']).status === 0
let dir = ''
let config = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-sshenvs-'))
  config = join(dir, 'ssh_config')
  writeFileSync(
    config,
    'Host build-box\n  HostName 192.0.2.10\n  User dev\n  Port 2222\n  ProxyJump bastion\n  StrictHostKeyChecking no\n',
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function machines() {
  const sent: Array<[string, unknown]> = []
  const store = new SshEnvironments({
    userDataDir: join(dir, 'user-data'),
    app: { version: '0.4.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: true,
    startedBy: 'Studio on dev-macbook-air',
    broadcast: (channel, payload) => sent.push([channel, payload]),
    configFile: config,
  })
  return { store, sent }
}

test.skipIf(!HAS_SSH)('a machine is resolved before it is saved, and saved with no credential', async () => {
  const { store, sent } = machines()
  const resolved = await store.resolve('build-box')
  assert.ok(resolved.ok)
  if (resolved.ok) {
    assert.deepEqual(
      { ...resolved.resolved, notes: resolved.resolved.notes.length },
      { hostname: '192.0.2.10', user: 'dev', port: 2222, proxyJump: 'bastion', notes: 1 },
    )
  }
  assert.equal((await store.resolve('-oProxyCommand=x')).ok, false)
  const added = await store.add({ destination: 'build-box' })
  assert.ok(added.ok && added.id)
  assert.equal((await store.add({ destination: 'build-box' })).ok, false, 'one entry per destination')
  assert.ok(sent.some(([channel]) => channel === SSH_ENV_CHANNELS.changed))
  const file = join(dir, 'user-data', 'ssh-environments.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { environments: Array<Record<string, unknown>> }
  assert.deepEqual(Object.keys(saved.environments[0]!).sort(), [
    'addedAt',
    'destination',
    'environmentId',
    'id',
    'label',
    'resolved',
    'settings',
  ])
  const [listed] = store.list()
  assert.equal(listed?.stateText, 'Not connected')
  assert.equal(listed?.action, 'connect')

  // Settings are checked; an install directory with a space is refused.
  assert.equal(store.update(added.id!, { installDir: '/opt/my dir' }).ok, false)
  assert.ok(store.update(added.id!, { installDir: '/opt/dev', keepRunning: true, paneTraffic: 'loopback' }).ok)
  assert.equal(store.get(added.id!)?.settings.paneTraffic, 'loopback')

  // A reload reads the same machine back.
  assert.equal(machines().store.list()[0]?.label, 'build-box')
  assert.ok((await store.forget(added.id!)).ok)
  assert.deepEqual(store.list(), [])
})

test('a prompt goes to every window and closes everywhere on the first answer', async () => {
  const { store, sent } = machines()
  const asking = (store as unknown as { ask: (request: object, signal: AbortSignal) => Promise<string | null> }).ask(
    { kind: 'password', text: "dev@build-box's password:", label: 'build-box' },
    new AbortController().signal,
  )
  const [, shown] = sent.find(([channel]) => channel === SSH_ENV_CHANNELS.prompt)! as [string, { id: string }]
  store.answer('not-a-prompt', 'x')
  store.answer(shown.id, 'pa ss')
  assert.equal(await asking, 'pa ss')
  assert.ok(
    sent.some(
      ([channel, payload]) => channel === SSH_ENV_CHANNELS.promptClosed && (payload as { id: string }).id === shown.id,
    ),
  )
  store.answer(shown.id, 'again')
  // Abandoned by ssh: closed with no answer.
  const controller = new AbortController()
  const gone = (store as unknown as { ask: (request: object, signal: AbortSignal) => Promise<string | null> }).ask(
    { kind: 'remote', text: '(dev@build-box) Code:', label: 'build-box' },
    controller.signal,
  )
  controller.abort()
  assert.equal(await gone, null)
})

test('diagnostics leave out addresses, tokens and the remote user name', () => {
  const text = redactDiagnostics(
    'ssh said: Connection to 203.0.113.7 port 22 closed\nhome /home/devuser\nfe80::1:2 here\nseown_abcdef',
    'devuser',
  )
  assert.ok(!text.includes('203.0.113.7'))
  assert.ok(!text.includes('devuser'))
  assert.ok(!text.includes('fe80::1:2'))
  assert.ok(!text.includes('seown_abcdef'))
})

test('a CLI Studio cannot sign in without a terminal is told the exact command, over the person own SSH', async () => {
  const { signInOverSsh } = await import('./ssh-environments')
  assert.equal(
    signInOverSsh('opencode', { destination: 'dev@build-box.example.com:2222', label: 'build-box' }),
    'Sign opencode in once on build-box over your own SSH session: ssh -t ssh://dev@build-box.example.com:2222 opencode auth login',
  )
  assert.match(signInOverSsh('grok', { destination: 'build-box', label: 'build-box' }), /API key/u)
})

test('an empty pasted code, or one the login would not take, ends the sign-in in words rather than waiting it out', async () => {
  const { store, sent } = machines()
  const internals = store as unknown as {
    saved: unknown[]
    askpass: () => Promise<unknown>
    connection: (id: string) => unknown
  }
  internals.saved.push({
    id: 'm1',
    label: 'build-box',
    destination: 'build-box',
    environmentId: null,
    settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
    addedAt: 0,
  })
  internals.askpass = async () => undefined
  const ops: string[] = []
  let pasteTaken = true
  const commandIds = new Set<string>()
  internals.connection = () => ({
    owner: {
      supports: (capability: string) => capability === 'provider-sign-in-flow',
      request: async (method: string, params: { commandId: string }) => {
        const op = method.replace('providers.signIn', '').toLowerCase()
        ops.push(op)
        // A step is one command: never two under one id.
        assert.ok(!commandIds.has(params.commandId))
        commandIds.add(params.commandId)
        if (op === 'start') return { ok: true, id: 'l1', url: 'https://example.test/login', code: null, paste: true }
        if (op === 'paste') return { ok: pasteTaken }
        // The login itself never finishes here, and a dropped connection would reject it.
        if (op === 'wait') return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('gone')), 50))
        return { ok: true }
      },
    },
  })
  const answerWith = async (answer: string) => {
    const signing = store.signIn('m1', conversationProviderForCli('claude-code')!)
    await vi.waitFor(() => assert.ok(sent.some(([channel]) => channel === SSH_ENV_CHANNELS.prompt)))
    const [, shown] = sent.findLast(([channel]) => channel === SSH_ENV_CHANNELS.prompt)! as [string, { id: string }]
    sent.length = 0
    store.answer(shown.id, answer)
    return signing
  }
  assert.deepEqual(await answerWith('   '), { ok: false, message: 'No code was pasted, so sign-in stopped.' })
  assert.deepEqual(ops, ['start', 'wait', 'cancel'])
  ops.length = 0
  pasteTaken = false
  assert.deepEqual(await answerWith('abc'), {
    ok: false,
    message: 'That code could not be sent to the sign-in. Try signing in again.',
  })
  assert.deepEqual(ops, ['start', 'wait', 'paste', 'cancel'])
})

test('a window is given a ticket the machine minted, for this computer’s loopback route to it', async () => {
  const { store } = machines()
  const internals = store as unknown as {
    saved: unknown[]
    connection: (id: string) => unknown
    connectQuietly: (id: string, ms: number) => Promise<boolean>
  }
  internals.saved.push({
    id: 'm1',
    label: 'build-box',
    destination: 'build-box',
    environmentId: null,
    settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
    addedAt: 0,
  })
  const asked: unknown[] = []
  let capable = true
  let connected = true
  internals.connectQuietly = async () => connected
  internals.connection = () =>
    connected
      ? {
          owner: {
            supports: (capability: string) => capable && capability === 'window-tickets',
            request: async (method: string, params: unknown) => {
              asked.push([method, params])
              return { token: 'ticket-1', path: '/ws?ticket=ticket-1' }
            },
          },
          open: async () => {
            throw new Error('not in this test')
          },
        }
      : null
  try {
    const first = await store.windowTicket('m1', { windowKey: 'window-7', origin: 'file://' })
    assert.ok(first.ok)
    const url = new URL(first.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(`${url.pathname}${url.search}`, '/ws?ticket=ticket-1')
    assert.equal(first.token, 'ticket-1')
    assert.deepEqual(asked, [['environment.windowTicket', { windowKey: 'window-7', origin: 'file://' }]])
    // The route is the machine's for the run: the next ticket names the same port.
    const second = await store.windowTicket('m1', { windowKey: 'window-7', origin: 'file://' })
    assert.ok(second.ok)
    assert.equal(new URL(second.url).port, url.port)

    capable = false
    const outdated = await store.windowTicket('m1', { windowKey: 'window-7', origin: 'file://' })
    assert.equal(outdated.ok ? null : outdated.code, 'outdated')
    connected = false
    const away = await store.windowTicket('m1', { windowKey: 'window-7', origin: 'file://' })
    assert.equal(away.ok ? null : away.code, 'unavailable')
    const unknown = await store.windowTicket('m2', { windowKey: 'window-7', origin: 'file://' })
    assert.equal(unknown.ok ? null : unknown.code, 'unknown_route')
  } finally {
    store.shutdown()
  }
})

test('a closed window’s document is revoked on every machine that gave it a ticket, and only those', async () => {
  const { store } = machines()
  const internals = store as unknown as {
    saved: unknown[]
    connection: (id: string) => unknown
    connectQuietly: (id: string, ms: number) => Promise<boolean>
  }
  for (const id of ['m1', 'm2'])
    internals.saved.push({
      id,
      label: id,
      destination: id,
      environmentId: `env-${id}`,
      settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
      addedAt: 0,
    })
  const asked: Array<[string, string, unknown]> = []
  internals.connectQuietly = async () => true
  internals.connection = (id: string) => ({
    label: id,
    environmentId: `env-${id}`,
    owner: {
      supports: () => true,
      request: async (method: string, params: unknown) => {
        asked.push([id, method, params])
        return { token: 'ticket-1', path: '/ws?ticket=ticket-1' }
      },
    },
  })
  try {
    assert.ok((await store.windowTicket('m1', { windowKey: 'window-4-1', origin: 'file://' })).ok)
    assert.ok((await store.windowTicket('m2', { windowKey: 'window-5-2', origin: 'file://' })).ok)
    asked.length = 0
    store.revokeWindow('window-4-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(asked, [['m1', 'environment.revokeWindow', { windowKey: 'window-4-1' }]])
    // Told once: the document is gone.
    store.revokeWindow('window-4-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(asked.length, 1)
  } finally {
    store.shutdown()
  }
})
