import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  STUDIO_AGENT_SKILLS_METHODS,
  STUDIO_METHOD_ACCESS,
  type SkillSourceUpdateCheck,
  type StudioAgentSkillsMethod,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import type { StudioAgentSkills } from '../core/studio-agent-skills'
import {
  connectLineClient,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'
import type { StudioChatBackend } from './studio-rpc-types'

// The `agent-skills` family over a real socket: every method under an owner,
// a paired app and a grant that may only read chats; the folders a client
// that is not an owner may name, checked on what they resolve to; the library
// a paired app is shown; and the sources' stream.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HERE = '/Users/dev/app'
const ELSEWHERE = '/Users/dev/private'
/** Studio knows HERE and everything under it, as `confineToRoots` holds a path. */
const knows = {
  isKnownFolder: async (path: string) => {
    const resolved = resolve(path)
    return resolved === HERE || resolved.startsWith(`${HERE}/`)
  },
} as unknown as StudioChatBackend

const CHECK: SkillSourceUpdateCheck = {
  checkedAt: '2026-11-12T00:00:00.000Z',
  sources: [],
  changed: [],
  newlyChanged: [],
  failures: [],
  skipped: [],
}

/** A domain that writes down each call by its path (`skills.install`, `designSystem.read`) and answers `{ ok: true }`. */
function stub() {
  const asked: string[] = []
  const sources = new Set<(check: SkillSourceUpdateCheck) => void>()
  const library = {
    entries: [
      {
        id: 'inside',
        path: `${HERE}/design`,
        name: 'Inside',
        version: '1',
        summary: '',
        releasedAt: null,
        sourceState: 'ok',
        addedAt: '',
      },
      {
        id: 'outside',
        path: `${ELSEWHERE}/design`,
        name: 'Outside',
        version: '1',
        summary: '',
        releasedAt: null,
        sourceState: 'ok',
        addedAt: '',
      },
    ],
  }
  const record =
    (path: string, answer: unknown = { ok: true }) =>
    async (..._args: unknown[]) => {
      asked.push(path)
      return answer
    }
  const group = (prefix: string, names: string[]) =>
    Object.fromEntries(names.map((name) => [name, record(`${prefix}.${name}`)]))
  const domain = {
    skills: group('skills', [
      'listSources',
      'checkSourceUpdates',
      'addSource',
      'addLocalSource',
      'removeSource',
      'syncSource',
      'getScan',
      'readFile',
      'install',
      'uninstall',
      'search',
      'listPopularRepos',
      'scanLinkedPlugin',
      'installPlugin',
      'uninstallPlugin',
      'listInstalledPlugins',
    ]),
    onSourcesUpdated: (listener: (check: SkillSourceUpdateCheck) => void) => {
      sources.add(listener)
      return () => void sources.delete(listener)
    },
    ensureUserSkillsFolder: () => {
      asked.push('ensureUserSkillsFolder')
      return '/Users/dev/.agents/skills'
    },
    workspaceSkills: group('workspaceSkills', ['listWorkspaceSkills']),
    agentCapabilities: group('agentCapabilities', ['resolve']),
    agentSkillInstaller: group('agentSkillInstaller', ['attach']),
    installedSkills: group('installedSkills', ['list', 'remove']),
    designSystem: {
      ...group('designSystem', ['register', 'forget', 'read', 'seed', 'lint', 'attach', 'detach']),
      library: async () => library,
      arrivals: async () => ({
        bundles: library.entries.map((entry) => ({ bundleId: entry.id, path: entry.path, addedAt: {} })),
      }),
    },
    runCard: record('runCard'),
  } as unknown as StudioAgentSkills
  return {
    domain,
    asked,
    emitSources: (check: SkillSourceUpdateCheck) => sources.forEach((listener) => listener(check)),
  }
}

async function serve(withSkills = true) {
  const stubbed = stub()
  const started = await startTestServer({ ...(withSkills ? { agentSkills: stubbed.domain } : {}), chat: knows })
  cleanups.push(() => started.dispose())
  return { started, ...stubbed }
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
const resultOf = (frame: unknown) => (frame as { result?: unknown }).result

let commands = 0
const c = () => `c${++commands}`

/** Each method with params its validator takes, every folder it names outside what Studio knows. */
const CALLS: Record<StudioAgentSkillsMethod, () => Record<string, unknown>> = {
  'skillSources.list': () => ({}),
  'skillSources.checkUpdates': () => ({}),
  'skillSources.add': () => ({ commandId: c(), repo: 'sprintengine/studio-releases' }),
  'skillSources.addLocal': () => ({ commandId: c(), folder: `${ELSEWHERE}/skills` }),
  'skillSources.remove': () => ({ commandId: c(), sourceId: 'github:a/b' }),
  'skillSources.sync': () => ({ commandId: c(), sourceId: 'github:a/b', workspaceFolder: ELSEWHERE }),
  'skills.scan': () => ({ sourceId: 'github:a/b' }),
  'skills.readFile': () => ({ sourceId: 'github:a/b', skillId: 's', path: 'SKILL.md' }),
  'skills.install': () => ({ commandId: c(), sourceId: 'github:a/b', skillId: 's', workspaceFolder: ELSEWHERE }),
  'skills.uninstall': () => ({ commandId: c(), workspaceFolder: ELSEWHERE, dirName: 's' }),
  'skills.search': () => ({ query: 'review' }),
  'skills.popularRepos': () => ({}),
  'skills.ensureUserFolder': () => ({ commandId: c() }),
  'skillPlugins.scanLinked': () => ({ sourceId: 'github:a/b', pluginId: 'p' }),
  'skillPlugins.install': () => ({ commandId: c(), sourceId: 'github:a/b', pluginId: 'p', workspaceRoot: ELSEWHERE }),
  'skillPlugins.uninstall': () => ({ commandId: c(), sourceId: 'github:a/b', pluginId: 'p', workspaceRoot: ELSEWHERE }),
  'skillPlugins.listInstalled': () => ({ workspaceFolder: ELSEWHERE }),
  'workspaceSkills.list': () => ({ workspaceFolder: ELSEWHERE }),
  'installedSkills.list': () => ({ workspaceFolder: ELSEWHERE, pluginId: 'claude-code' }),
  'installedSkills.remove': () => ({
    commandId: c(),
    workspaceFolder: ELSEWHERE,
    pluginId: 'claude-code',
    installationId: 'i',
  }),
  'agentCapabilities.resolve': () => ({ workspaceFolder: ELSEWHERE, pluginId: 'claude-code' }),
  'agentSkills.attach': () => ({ commandId: c(), workspaceFolder: ELSEWHERE, skillId: 'studio-ship' }),
  'designSystem.library': () => ({}),
  'designSystem.arrivals': () => ({}),
  'designSystem.register': () => ({ commandId: c(), folder: `${ELSEWHERE}/design` }),
  'designSystem.forget': () => ({ commandId: c(), id: 'inside' }),
  'designSystem.read': () => ({ bundleFolder: `${ELSEWHERE}/design` }),
  'designSystem.seed': () => ({
    commandId: c(),
    sourceFolder: null,
    targetFolder: `${ELSEWHERE}/new`,
    name: 'N',
    summary: '',
  }),
  'designSystem.lint': () => ({ commandId: c(), bundleFolder: `${ELSEWHERE}/design` }),
  'designSystem.attach': () => ({ commandId: c(), source: { kind: 'library', id: 'outside' }, workspaceFolder: HERE }),
  'designSystem.detach': () => ({ commandId: c(), workspaceFolder: ELSEWHERE }),
  'cards.run': () => ({
    commandId: c(),
    slug: 'card',
    actions: [],
    workspaceRoot: null,
    cloneParentDir: null,
    mcpServers: [],
    mcpSyncEnabled: false,
  }),
}

const OWNERS_ONLY = ['cards.run', 'designSystem.lint', 'skillPlugins.install', 'skillPlugins.uninstall']
const ownersOnly = (method: string) => {
  const access = STUDIO_METHOD_ACCESS[method as StudioAgentSkillsMethod]
  return 'permissions' in access && access.owner !== undefined
}
const namesAFolder = (params: Record<string, unknown>) =>
  JSON.stringify(params).includes(ELSEWHERE) || (params.source as { kind?: string } | undefined)?.kind === 'library'

test('every method of the family has a call here, and only those four are an owner’s', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_AGENT_SKILLS_METHODS).sort())
  assert.deepEqual(Object.keys(CALLS).filter(ownersOnly).sort(), OWNERS_ONLY)
})

test('a Studio advertises its skills only where it holds them; an older one is answered unavailable', async () => {
  const without = await serve(false)
  const older = await client(without.started.path, OWNER_TOKEN)
  assert.equal(older.welcome.t === 'welcome' && older.welcome.capabilities.includes('agent-skills'), false)
  assert.equal(codeOf(await older.request('skillSources.list', {})), 'unavailable')
  const withIt = await serve()
  const window = await client(withIt.started.path, OWNER_TOKEN)
  assert.equal(window.welcome.t === 'welcome' && window.welcome.capabilities.includes('agent-skills'), true)
})

test('an owner reaches every method, names any folder, sees the whole library and hears the sources', async () => {
  const { started, asked, emitSources } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await owner.request(method, params()))], [method, null])
  assert.ok(asked.includes('runCard') && asked.includes('skills.installPlugin') && asked.includes('designSystem.lint'))
  const library = resultOf(await owner.request('designSystem.library', {})) as { entries: Array<{ id: string }> }
  assert.deepEqual(
    library.entries.map((entry) => entry.id),
    ['inside', 'outside'],
  )
  // A workspace on an SSH machine is answered in words, not read here.
  const remote = await owner.request('workspaceSkills.list', { workspaceFolder: 'ssh://build-box/home/dev/app' })
  assert.equal(codeOf(remote), 'unavailable')
  const sub = await owner.subscribe('skillSources.updated')
  await new Promise((resolve) => setTimeout(resolve, 20))
  emitSources(CHECK)
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === sub)
})

test('a paired app names only the folders Studio knows, on what they resolve to, and reaches nothing an owner’s', async () => {
  const { started, asked } = await serve()
  const scopes: StudioScope[] = [
    'providers:read',
    'files:read',
    'files:write',
    'settings:write',
    'environment:maintain',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS)) {
    const called = params()
    const expected = ownersOnly(method) ? 'owner_required' : namesAFolder(called) ? 'not_found' : null
    assert.deepEqual([method, codeOf(await app.request(method, called))], [method, expected])
  }
  // Nothing about a folder it may not name, nor anything only an owner may do, reached the domain.
  const aboutAFolder = [
    'skills.addLocalSource',
    'skills.syncSource',
    'skills.install',
    'skills.uninstall',
    'skills.installPlugin',
    'skills.uninstallPlugin',
    'skills.listInstalledPlugins',
    'workspaceSkills.listWorkspaceSkills',
    'installedSkills.list',
    'installedSkills.remove',
    'agentCapabilities.resolve',
    'agentSkillInstaller.attach',
    'designSystem.register',
    'designSystem.read',
    'designSystem.seed',
    'designSystem.lint',
    'designSystem.attach',
    'designSystem.detach',
    'runCard',
  ]
  assert.deepEqual(
    asked.filter((path) => aboutAFolder.includes(path)),
    [],
  )
  // Inside what Studio knows, the same calls are answered.
  for (const [method, params] of [
    ['workspaceSkills.list', { workspaceFolder: HERE }],
    ['skills.install', { commandId: c(), sourceId: 'github:a/b', skillId: 's', workspaceFolder: HERE }],
    ['designSystem.read', { bundleFolder: `${HERE}/design` }],
    [
      'designSystem.seed',
      { commandId: c(), sourceFolder: `${HERE}/design`, targetFolder: `${HERE}/new`, name: 'N', summary: '' },
    ],
    ['designSystem.attach', { commandId: c(), source: { kind: 'library', id: 'inside' }, workspaceFolder: HERE }],
    ['skills.install', { commandId: c(), sourceId: 'github:a/b', skillId: 's', workspaceFolder: null }],
  ] as const)
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, null])
  // A path that climbs out of a known folder is the folder it climbs to.
  const climbs = await app.request('designSystem.read', { bundleFolder: `${HERE}/../private/design` })
  assert.equal(codeOf(climbs), 'not_found')
  // The library shows it only what it could name.
  const library = resultOf(await app.request('designSystem.library', {})) as { entries: Array<{ id: string }> }
  assert.deepEqual(
    library.entries.map((entry) => entry.id),
    ['inside'],
  )
  const arrivals = resultOf(await app.request('designSystem.arrivals', {})) as { bundles: Array<{ bundleId: string }> }
  assert.deepEqual(
    arrivals.bundles.map((bundle) => bundle.bundleId),
    ['inside'],
  )
})

test('a grant that may only read chats reaches none of it', async () => {
  const { started, asked } = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual(
      [method, codeOf(await reader.request(method, params()))],
      [method, ownersOnly(method) ? 'owner_required' : 'scope_required'],
    )
  const id = await reader.subscribe('skillSources.updated')
  const failed = await reader.line.next((frame) => frame.t === 'subFailed' && frame.sub === id)
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')
  assert.deepEqual(asked, [])
})

test('a card whose params are not one is refused before anything runs', async () => {
  const { started, asked } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const bad of [
    { ...CALLS['cards.run'](), actions: 'install everything' },
    { ...CALLS['cards.run'](), workspaceRoot: 42 },
    { ...CALLS['cards.run'](), permissionPreset: 'root' },
    { ...CALLS['cards.run'](), mcpServers: ['not a server'] },
  ])
    assert.equal(codeOf(await owner.request('cards.run', bad)), 'invalid_params')
  assert.deepEqual(asked, [])
})
