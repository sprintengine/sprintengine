import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import {
  STUDIO_AGENT_SETTINGS_METHODS,
  STUDIO_METHOD_ACCESS,
  type AgentLaunchSettingsRecord,
  type CliModelDiscoveryResult,
  type CliUpdateAllItem,
  type CliVersionAdvisoriesResult,
  type StudioAgentSettingsMethod,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import type { CliRuntimes } from '../../main/cli-runtimes'
import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import type { StudioAgentSettings } from '../agent-settings/agent-settings-domain'
import {
  connectLineClient,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'

// `cliRuntimes.*`, `cliVersions.*`, `cliModels.*`, `launchSettings.*`,
// `textGeneration.*` and `commitMessage.*` over the owner socket, under every
// kind of grant: an owner's, a pairing given the scopes, one that may only
// read chats, and one revoked. The domains behind them are stubs; what they
// decide is cli-runtimes.test.ts's and agent-settings-domain.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Listener<T> = Set<(value: T) => void>

function stubs() {
  const asked: Array<[string, unknown]> = []
  const output: Listener<[string, string, string]> = new Set()
  const progress: Listener<CliUpdateAllItem[]> = new Set()
  const advisories: Listener<CliVersionAdvisoriesResult> = new Set()
  const models: Listener<CliModelDiscoveryResult> = new Set()
  const launch: Listener<AgentLaunchSettingsRecord> = new Set()
  const listen =
    <T>(set: Listener<T>) =>
    (listener: (value: T) => void) => {
      set.add(listener)
      return () => void set.delete(listener)
    }
  const installed = {
    ok: true,
    cli: 'codex',
    installed: true,
    version: '1.0.0',
    resolvedPath: '/bin/codex',
    log: '',
    error: null,
  }
  const record: AgentLaunchSettingsRecord = {
    schemaVersion: 2,
    revision: 1,
    settings: emptyAgentLaunchSettings(),
    changedAt: 0,
    lastWrite: { actor: 'ui', at: '' },
  }
  const runtimes: CliRuntimes = {
    detect: async (cli, runtime) => {
      asked.push(['detect', { cli, runtime }])
      return { cli, binary: cli, installed: true, version: '1.0.0', resolvedPath: null, hostId: 'local', error: null }
    },
    installMethods: async () => [],
    install: async (input, runtime) => {
      asked.push(['install', { ...input, runtime }])
      return installed
    },
    update: async (cli) => {
      asked.push(['update', cli])
      return installed
    },
    updateAll: async () => ({ ok: true, items: [] }),
    advisories: async () => ({ ok: true, advisories: {}, checkedAt: 'now' }),
    setVersionChecksEnabled: (enabled) => enabled,
    onOutput: (listener) => {
      const each = ([cli, hostId, chunk]: [string, string, string]) => listener(cli, hostId as 'local', chunk)
      output.add(each)
      return () => void output.delete(each)
    },
    onUpdateAllProgress: listen(progress),
    onAdvisoriesChanged: listen(advisories),
  }
  const settings: StudioAgentSettings = {
    launchSettings: async () => ({ record, settings: record.settings, persisted: true }),
    updateLaunchSettings: async (patch) => {
      asked.push(['launch.update', patch])
      return { ok: true, record, changed: true, persisted: true }
    },
    migrateLaunchSettings: async () => ({ ok: true, record, changed: false, persisted: true }),
    onLaunchSettingsChanged: listen(launch),
    discoverModels: async (input) => {
      asked.push(['discover', input])
      return { entries: [], startedAt: '', finishedAt: '' }
    },
    onModelsChanged: listen(models),
    setTextGenerationSettings: (chosen) => void asked.push(['textGeneration', chosen]),
    chatTitle: async () => ({ ok: true, value: 'A title', ms: 1 }),
    draftCommitMessage: async (request, key) => {
      asked.push(['draft', { repoRoot: request.repoRoot, key }])
      return { ok: true, value: { subject: 's', body: '', message: 's' }, ms: 1 }
    },
    cancelCommitMessage: (key) => void asked.push(['cancel', key]),
  }
  const emit = {
    output: (cli: string, hostId: string, chunk: string) =>
      output.forEach((listener) => listener([cli, hostId, chunk])),
    progress: (items: CliUpdateAllItem[]) => progress.forEach((listener) => listener(items)),
    advisories: (result: CliVersionAdvisoriesResult) => advisories.forEach((listener) => listener(result)),
    models: (result: CliModelDiscoveryResult) => models.forEach((listener) => listener(result)),
    launch: (next: AgentLaunchSettingsRecord) => launch.forEach((listener) => listener(next)),
  }
  return { runtimes, settings, asked, emit, record }
}

async function serve(given: { runtimes?: boolean; settings?: boolean } = { runtimes: true, settings: true }) {
  const domains = stubs()
  const started = await startTestServer({
    ...(given.runtimes ? { runtimes: domains.runtimes } : {}),
    ...(given.settings ? { agentSettings: domains.settings } : {}),
  })
  cleanups.push(() => started.dispose())
  return { started, ...domains }
}

type Client = Awaited<ReturnType<typeof client>>

async function client(path: string, token: string) {
  const line: LineClient = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown = {}) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null
const resultOf = (frame: { t: string; ok?: boolean; result?: unknown }) =>
  frame.t === 'res' && frame.ok ? frame.result : undefined

/** Each method with params its validator takes. */
const CALLS: Record<StudioAgentSettingsMethod, Record<string, unknown>> = {
  'cliRuntimes.detect': { cli: 'codex' },
  'cliRuntimes.installMethods': { cli: 'codex' },
  'cliRuntimes.install': { commandId: 'c-install', cli: 'codex', methodId: 'npm' },
  'cliRuntimes.update': { commandId: 'c-update', cli: 'codex' },
  'cliRuntimes.updateAll': { commandId: 'c-all' },
  'cliVersions.advisories': {},
  'cliVersions.setEnabled': { commandId: 'c-enabled', enabled: true },
  'cliModels.discover': { clis: ['codex'] },
  'launchSettings.get': {},
  'launchSettings.update': { commandId: 'c-launch', patch: { lastSelectedCli: 'codex' } },
  'launchSettings.migrate': { commandId: 'c-migrate', settings: { lastSelectedCli: 'codex' } },
  'textGeneration.setSettings': {
    commandId: 'c-text',
    settings: { enabled: true, engine: null, writingStyle: { mode: 'repository', instructions: '' } },
  },
  'textGeneration.chatTitle': { prompt: 'fix it', engine: { cli: 'codex', model: '' } },
  'commitMessage.draft': { repoRoot: '/Users/dev/app', engine: { cli: 'codex', model: '' }, draftId: 'd1' },
  'commitMessage.cancel': { draftId: 'd1' },
}

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_AGENT_SETTINGS_METHODS).sort())
})

test('a Studio advertises what it holds, and refuses what it does not', async () => {
  const both = await serve()
  const owner = await client(both.started.path, OWNER_TOKEN)
  const capabilities = owner.welcome.t === 'welcome' ? owner.welcome.capabilities : []
  assert.ok(capabilities.includes('agent-runtimes') && capabilities.includes('agent-settings'))

  // Out of process the server holds the launch settings but not the CLIs' detection.
  const settingsOnly = await serve({ settings: true })
  const window = await client(settingsOnly.started.path, OWNER_TOKEN)
  const advertised = window.welcome.t === 'welcome' ? window.welcome.capabilities : []
  assert.equal(advertised.includes('agent-runtimes'), false)
  assert.equal(advertised.includes('agent-settings'), true)
  assert.equal(codeOf(await window.request('cliRuntimes.detect', { cli: 'codex' })), 'unavailable')
  const refused = await window.subscribe('cliVersions.changed')
  const failed = await window.line.next((frame) => frame.t === 'subFailed' && frame.sub === refused)
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test('an owner reaches every method, and names a CLI program and any folder', async () => {
  const { started, asked } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, null])
  await owner.request('cliRuntimes.detect', { cli: 'codex', runtime: { command: '/opt/codex', hostId: 'wsl:Ubuntu' } })
  assert.deepEqual(
    asked.find(([kind, input]) => kind === 'detect' && JSON.stringify(input).includes('/opt/codex')),
    ['detect', { cli: 'codex', runtime: { command: '/opt/codex', hostId: 'wsl:Ubuntu' } }],
  )
  assert.deepEqual(
    asked.filter(([kind]) => kind === 'draft' || kind === 'cancel'),
    [
      ['draft', { repoRoot: '/Users/dev/app', key: 'owner:d1' }],
      ['cancel', 'owner:d1'],
    ],
    "a draft is keyed by its client, so one client never stops another's",
  )
})

test('an owner follows every stream; output only for the CLI and machine it names', async () => {
  const { started, emit, record } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const here = await owner.subscribe('cliRuntimes.output', { cli: 'codex' })
  const wsl = await owner.subscribe('cliRuntimes.output', { cli: 'codex', hostId: 'wsl:Ubuntu' })
  const progress = await owner.subscribe('cliRuntimes.updateAllProgress')
  const versions = await owner.subscribe('cliVersions.changed')
  const models = await owner.subscribe('cliModels.changed')
  const launch = await owner.subscribe('launchSettings.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  emit.output('codex', 'wsl:Ubuntu', 'in the distribution\n')
  emit.output('claude-code', 'local', 'another CLI\n')
  emit.output('codex', 'local', 'here\n')
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === here)
  assert.deepEqual(pushed.t === 'push' && pushed.payload, { chunk: 'here\n' })
  const there = await owner.line.next((frame) => frame.t === 'push' && frame.sub === wsl)
  assert.deepEqual(there.t === 'push' && there.payload, { chunk: 'in the distribution\n' })
  // Read frames are taken off the list: nothing else was sent to the follower of this machine's codex.
  assert.equal(owner.line.frames.filter((frame) => frame.t === 'push' && frame.sub === here).length, 0)
  emit.progress([{ hostId: 'local', cli: 'codex', from: '1', latest: '2', state: 'queued' }])
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === progress)
  emit.advisories({ ok: true, advisories: {}, checkedAt: 'now' })
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === versions)
  emit.models({ entries: [], startedAt: '', finishedAt: '' })
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === models)
  emit.launch({ ...record, revision: 2 })
  const next = await owner.line.next((frame) => frame.t === 'push' && frame.sub === launch)
  assert.equal(next.t === 'push' && (next.payload as AgentLaunchSettingsRecord).revision, 2)
})

test('a paired app reaches what its scopes name; a CLI program, the launch settings and an unknown folder are not its', async () => {
  const { started, asked } = await serve()
  const scopes: StudioScope[] = [
    'providers:read',
    'environment:maintain',
    'settings:write',
    'conversation:read',
    'conversation:operate',
    'files:read',
    'workspaces:read',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS)) {
    const owner = STUDIO_METHOD_ACCESS[method as StudioAgentSettingsMethod]
    const expected =
      'permissions' in owner && owner.owner !== undefined
        ? 'owner_required'
        : method === 'commitMessage.draft'
          ? 'not_found'
          : null
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, expected])
  }
  // The program a CLI runs is an owner's to name, however it is named.
  for (const [method, params] of [
    ['cliRuntimes.detect', { cli: 'codex', runtime: { command: '/tmp/evil' } }],
    ['cliRuntimes.install', { commandId: 'c2', cli: 'codex', methodId: 'npm', runtime: { command: '/tmp/evil' } }],
    ['cliModels.discover', { cliRuntimes: { codex: { command: '/tmp/evil' } } }],
    [
      'textGeneration.chatTitle',
      { prompt: 'x', engine: { cli: 'codex', model: '' }, cliRuntimes: { codex: { command: '/tmp/evil' } } },
    ],
  ] as const)
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, 'owner_required'])
  assert.equal(
    asked.some(([, input]) => JSON.stringify(input).includes('/tmp/evil')),
    false,
    'no program it named reached a domain',
  )
  // A machine is the app's to name.
  const detected = await app.request('cliRuntimes.detect', { cli: 'codex', runtime: { hostId: 'wsl:Ubuntu' } })
  assert.equal(codeOf(detected), null)
  assert.equal(
    asked.some(([kind]) => kind === 'draft'),
    false,
    'a folder Studio does not know is never read',
  )
  const launch = await app.subscribe('launchSettings.changed')
  const refused = await app.line.next((frame) => frame.t === 'subFailed' && frame.sub === launch)
  assert.equal(refused.t === 'subFailed' && refused.code, 'owner_required')
  const output = await app.subscribe('cliRuntimes.output', { cli: 'codex' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    app.line.frames.some((frame) => frame.t === 'subFailed' && frame.sub === output),
    false,
    'environment:maintain follows an install',
  )
})

test('a grant that may only read chats reaches none of it', async () => {
  const { started, asked } = await serve()
  const reader: Client = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  for (const [method, params] of Object.entries(CALLS)) {
    const access = STUDIO_METHOD_ACCESS[method as StudioAgentSettingsMethod]
    const expected = 'permissions' in access && access.owner !== undefined ? 'owner_required' : 'scope_required'
    assert.deepEqual([method, codeOf(await reader.request(method, params))], [method, expected])
  }
  for (const topic of ['cliRuntimes.updateAllProgress', 'cliVersions.changed', 'cliModels.changed']) {
    const id = await reader.subscribe(topic)
    const failed = await reader.line.next((frame) => frame.t === 'subFailed' && frame.sub === id)
    assert.deepEqual([topic, failed.t === 'subFailed' && failed.code], [topic, 'scope_required'])
  }
  assert.deepEqual(asked, [])
})

test('a revoked app is ended at its next frame, and hears nothing after', async () => {
  const { started, emit } = await serve()
  const app = await client(started.path, pairFakeClient(started.auth, 'app', ['providers:read']))
  assert.ok(resultOf(await app.request('cliVersions.advisories', {})))
  await app.subscribe('cliVersions.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  started.auth.grants.delete('app')
  emit.advisories({ ok: false, message: 'after the revoke' })
  const bye = await app.line.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  assert.equal(
    app.line.frames.some((frame) => frame.t === 'push' && JSON.stringify(frame).includes('after the revoke')),
    false,
  )
})
