import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import {
  STUDIO_AGENT_SETUP_METHODS,
  STUDIO_METHOD_ACCESS,
  type MemoryActivityEvent,
  type StudioAgentSetupMethod,
  type StudioAreaSkillChoices,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import type { StudioAgentSetup } from '../agent-setup/agent-setup-domain'
import {
  connectLineClient,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'
import type { StudioChatBackend } from './studio-rpc-types'

// `memory.*`, `memoryActivity.*`, `mcp.sync`, `agentConfig.*`,
// `builtinSkills.*` and `areaSkills.*` over the owner socket, under every kind
// of grant: an owner's, a pairing given the scopes, one that may only read
// chats, and one revoked. The domain behind them is a stub.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const CHOICES: StudioAreaSkillChoices = { enabled: ['studio-backlog'], dismissed: [] }

function stub() {
  const asked: Array<[string, unknown]> = []
  const events = new Set<(event: MemoryActivityEvent) => void>()
  const areas = new Set<(choices: StudioAreaSkillChoices) => void>()
  const note =
    <T>(kind: string, answer: T) =>
    async (...args: unknown[]) => {
      asked.push([kind, args])
      return answer
    }
  const missing = { ok: false as const, status: 'missing-workspace' as const, relativeRoot: null, message: 'none' }
  const setup: StudioAgentSetup = {
    resolveMemoryRoot: note('resolveRoot', missing),
    indexMemory: note('index', missing),
    readMemoryPreview: note('preview', { ok: false, message: 'none' }),
    installMemoryActivity: note('install', { ok: false, message: 'none' }),
    uninstallMemoryActivity: note('uninstall', { ok: true }),
    startMemoryActivityWatching: note('watch', undefined),
    memoryActivityStatus: (workspaceRoot) => ({
      workspaceRoot,
      isInstalled: false,
      isWatching: false,
      sessionsRecorded: 0,
      totalEvents: 0,
      eventsToday: 0,
      lastEventAt: null,
    }),
    memoryActivitySynapses: () => [],
    memoryActivityInstalled: note('installed', false),
    onMemoryActivityEvent: (listener) => {
      events.add(listener)
      return () => void events.delete(listener)
    },
    onMemoryActivityStatus: () => () => undefined,
    onMemoryActivitySynapses: () => () => undefined,
    syncMcp: note('sync', { ok: true, targets: [], issues: [] }),
    detectAgentConfig: note('detect', { ok: true, mcpServers: [], skills: [], warnings: [] }),
    adoptAgentConfig: note('adopt', { ok: true, adoptedMcpServers: [], adoptedSkills: [], warnings: [] }),
    builtinSkills: note('builtins', []),
    builtinSkillStatus: note('builtinStatus', { ok: false, status: 'unknown-skill', skillId: 'x', message: 'none' }),
    areaSkills: () => CHOICES,
    setAreaSkillEnabled: note('areaEnabled', CHOICES),
    dismissAreaSkill: note('areaDismiss', CHOICES),
    onAreaSkillsChanged: (listener) => {
      areas.add(listener)
      return () => void areas.delete(listener)
    },
  }
  return {
    setup,
    asked,
    emitEvent: (event: MemoryActivityEvent) => events.forEach((listener) => listener(event)),
    emitAreas: (choices: StudioAreaSkillChoices) => areas.forEach((listener) => listener(choices)),
  }
}

async function serve(withSetup = true, chat?: StudioChatBackend) {
  const domain = stub()
  const started = await startTestServer({
    ...(withSetup ? { agentSetup: domain.setup } : {}),
    ...(chat ? { chat } : {}),
  })
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

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
    async subscribe(topic: string) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params: {} })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null

const HERE = '/Users/dev/app'

/** Each method with params its validator takes, naming a workspace on this disk. */
const CALLS: Record<StudioAgentSetupMethod, Record<string, unknown>> = {
  'memory.resolveRoot': { workspaceFolder: HERE, relativeRoot: 'docs' },
  'memory.index': { workspaceFolder: HERE, relativeRoot: 'docs' },
  'memory.readPreview': { workspaceFolder: HERE, relativeRoot: 'docs', relativePath: 'a.md' },
  'memoryActivity.install': { commandId: 'c1', workspaceFolder: HERE, memoryRelativeRoot: 'docs' },
  'memoryActivity.uninstall': { commandId: 'c2', workspaceFolder: HERE },
  'memoryActivity.startWatching': { workspaceFolder: HERE, memoryRelativeRoot: 'docs' },
  'memoryActivity.status': { workspaceFolder: HERE },
  'memoryActivity.synapses': { workspaceFolder: HERE },
  'memoryActivity.isInstalled': { workspaceFolder: HERE },
  'mcp.sync': { commandId: 'c3', workspaceRoot: HERE, settings: { syncEnabled: true, servers: {} } },
  'agentConfig.detect': {},
  'agentConfig.adopt': { commandId: 'c4', workspaceRoot: HERE },
  'builtinSkills.list': {},
  'builtinSkills.status': { workspaceFolder: HERE, skillId: 'studio-ship' },
  'areaSkills.get': {},
  'areaSkills.setEnabled': { commandId: 'c5', skillId: 'studio-backlog', enabled: true },
  'areaSkills.dismiss': { commandId: 'c6', skillId: 'studio-backlog' },
}

const ownersOnly = (method: string) => {
  const access = STUDIO_METHOD_ACCESS[method as StudioAgentSetupMethod]
  return 'permissions' in access && access.owner !== undefined
}
const namesWorkspace = (params: Record<string, unknown>) =>
  typeof params.workspaceFolder === 'string' || typeof params.workspaceRoot === 'string'

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_AGENT_SETUP_METHODS).sort())
})

test('a Studio advertises its agents’ setup only where it holds it', async () => {
  const without = await serve(false)
  const owner = await client(without.started.path, OWNER_TOKEN)
  assert.equal(owner.welcome.t === 'welcome' && owner.welcome.capabilities.includes('agent-setup'), false)
  assert.equal(codeOf(await owner.request('builtinSkills.list', {})), 'unavailable')
  const withIt = await serve()
  const window = await client(withIt.started.path, OWNER_TOKEN)
  assert.equal(window.welcome.t === 'welcome' && window.welcome.capabilities.includes('agent-setup'), true)
})

test('an owner reaches every method, names any folder, and hears every stream', async () => {
  const { started, asked, emitEvent, emitAreas } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, null])
  assert.ok(asked.some(([kind]) => kind === 'sync'))
  // A workspace on an SSH machine is answered in words, not read here.
  const remote = await owner.request('memory.index', {
    workspaceFolder: 'ssh://build-box/home/dev/app',
    relativeRoot: null,
  })
  assert.equal(codeOf(remote), 'unavailable')
  const events = await owner.subscribe('memoryActivity.events')
  const areas = await owner.subscribe('areaSkills.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  emitEvent({
    workspaceRoot: HERE,
    sessionId: 's',
    nodeId: 'a',
    prevNodeId: null,
    tool: 'Read',
    ts: 1,
    synapseCount: 0,
  })
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === events)
  emitAreas(CHOICES)
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === areas)
})

test('a paired app reaches what its scopes name, no folder Studio does not know, and nothing that writes what CLIs run', async () => {
  const { started, asked } = await serve()
  const scopes: StudioScope[] = ['files:read', 'providers:read', 'settings:write']
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS)) {
    const expected = ownersOnly(method) ? 'owner_required' : namesWorkspace(params) ? 'not_found' : null
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, expected])
  }
  // Nothing about a folder it may not name, nor anything only an owner may do, reached the domain.
  assert.deepEqual(asked.map(([kind]) => kind).sort(), ['areaDismiss', 'areaEnabled', 'builtins', 'detect'])
  // With no workspace named, the reads that take none are answered.
  assert.equal(codeOf(await app.request('memoryActivity.status', { workspaceFolder: null })), null)
})

test('a knowledge root a paired app names stays inside the folders Studio knows', async () => {
  // Studio knows HERE and everything under it, as `confineToRoots` holds a path.
  const knows = { isKnownFolder: async (path: string) => path === HERE || path.startsWith(`${HERE}/`) }
  const { started, asked } = await serve(true, knows as unknown as StudioChatBackend)
  const app = await client(started.path, pairFakeClient(started.auth, 'app', ['files:read']))
  const inside = { workspaceFolder: HERE, relativeRoot: 'docs' }
  const climbs = { workspaceFolder: HERE, relativeRoot: '../../..' }
  assert.equal(codeOf(await app.request('memory.resolveRoot', inside)), null)
  assert.equal(codeOf(await app.request('memory.index', inside)), null)
  for (const [method, params] of [
    ['memory.resolveRoot', climbs],
    ['memory.index', climbs],
    ['memory.readPreview', { ...climbs, relativePath: 'etc/hosts' }],
    ['memory.readPreview', { workspaceFolder: HERE, relativeRoot: '/', relativePath: 'etc/hosts' }],
    ['memoryActivity.startWatching', { workspaceFolder: HERE, memoryRelativeRoot: '../other' }],
  ] as const)
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, 'not_found'])
  assert.deepEqual(
    asked.map(([kind]) => kind),
    ['resolveRoot', 'index'],
  )
})

test('a grant that may only read chats reaches none of it', async () => {
  const { started, asked } = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual(
      [method, codeOf(await reader.request(method, params))],
      [method, ownersOnly(method) ? 'owner_required' : 'scope_required'],
    )
  for (const topic of ['memoryActivity.events', 'areaSkills.changed']) {
    const id = await reader.subscribe(topic)
    const failed = await reader.line.next((frame) => frame.t === 'subFailed' && frame.sub === id)
    assert.deepEqual([topic, failed.t === 'subFailed' && failed.code], [topic, 'scope_required'])
  }
  assert.deepEqual(asked, [])
})

test('a revoked app is ended at its next frame, and hears nothing after', async () => {
  const { started, emitAreas } = await serve()
  const app = await client(started.path, pairFakeClient(started.auth, 'app', ['providers:read']))
  assert.equal(codeOf(await app.request('areaSkills.get', {})), null)
  await app.subscribe('areaSkills.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  started.auth.grants.delete('app')
  emitAreas({ enabled: [], dismissed: ['studio-ship'] })
  const bye = await app.line.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  assert.equal(
    app.line.frames.some((frame) => frame.t === 'push' && JSON.stringify(frame).includes('studio-ship')),
    false,
  )
})
