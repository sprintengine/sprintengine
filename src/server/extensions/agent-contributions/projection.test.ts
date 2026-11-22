// What installed extensions hand agents and chats, through the lifecycle that
// installs, approves, switches and uninstalls them: skills, MCP servers and
// model providers, each installed, updated (added, changed, removed) and
// uninstalled, the approval each asks for or does not, and a projection a
// crash interrupted, put right by the next start.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { createModuleLifecycle } from '../../../main/modules/module-lifecycle'
import { createModuleRegistryMirror } from '../../../main/modules/registry-mirror'
import { NO_EXTENSION_RUN } from '../../../main/modules/third-party-module-view'
import { extensionManifest, writeExtensionFolder } from '../../../../tests/extension-folder'
import { createPluginRegistry } from '../../../main/plugin-registry'
import { extensionProviderOf } from '../../../main/plugin-registry-instance'
import {
  AGENT_CONTRIBUTIONS_DIR,
  chatExtensionContributions,
  launchExtensionContributions,
  projectedExtensions,
  projectedProviders,
  readAgentContributions,
} from './projection'

const SKILL = '---\nname: review\ndescription: Review a change.\n---\nLook at the diff.\n'

function setup(protectedIds: string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-contributions-'))
  const moduleRoot = join(dataDir, 'extensions')
  const warnings: string[] = []
  const start = () =>
    createModuleLifecycle({
      dataDir,
      moduleRoot: () => moduleRoot,
      view: () => null,
      applyEnablement: async () => ({ ok: true }),
      changed: () => undefined,
      run: () => NO_EXTENSION_RUN,
      registry: createModuleRegistryMirror(),
      protectedProviderIds: () => new Set(protectedIds),
      warn: (message) => warnings.push(message),
    })
  let version = 0
  // A source folder for each version of the extension the test installs.
  const source = (contributes: Record<string, unknown>, files: Record<string, string> = {}) => {
    version += 1
    return writeExtensionFolder(join(dataDir, `src-${version}`), {
      manifest: extensionManifest({
        id: 'tools',
        version: `1.0.${version}`,
        tier: 'declarative',
        permissions: [],
        main: undefined,
        contributes,
      }),
      files: { 'skills/review/SKILL.md': SKILL, 'dist/server.js': 'console.log(1)\n', ...files },
    })
  }
  return { dataDir, moduleRoot, warnings, start, source, root: join(dataDir, AGENT_CONTRIBUTIONS_DIR) }
}

const stdio = (args: string[] = ['${extensionPath}/dist/server.js']) => ({
  id: 'search',
  name: 'Search',
  transport: 'stdio',
  command: 'node',
  args,
  env: [{ name: 'LOG_LEVEL', value: 'info' }],
})
const http = (url = 'https://mcp.example.com/mcp') => ({ id: 'docs', name: 'Docs', transport: 'http', url })
const provider = (baseUrl = 'https://api.example.com') => ({
  id: 'acme',
  name: 'Acme',
  baseUrl,
  modelsPath: '/v1/models',
  models: [{ id: 'acme-large', name: 'Acme Large' }],
  apiKey: { label: 'Acme API key' },
})

const KEY = 'local.tools'

test('a skill is listed, asks nothing, and its copy follows every install, update and uninstall', async () => {
  const { dataDir, start, source, root } = setup()
  const lifecycle = start()
  const installed = await lifecycle.install(source({ skills: [{ id: 'review', path: 'skills/review' }] }))
  expect(installed).toMatchObject({ ok: true, moduleId: KEY, approval: { state: 'not-needed' } })

  const [first] = launchExtensionContributions(dataDir).skills
  expect(first).toMatchObject({ name: 'local.tools.review' })
  expect(readFileSync(join(first!.dir, 'SKILL.md'), 'utf8')).toBe(SKILL)
  // The projection folder is a plugin directory agents load as it is.
  expect(JSON.parse(readFileSync(join(first!.pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe(
    'local--tools',
  )
  expect(chatExtensionContributions(dataDir).pluginDirs).toEqual([first!.pluginDir])

  // Changed: a new copy, and the old one gone.
  await lifecycle.install(
    source(
      { skills: [{ id: 'review', path: 'skills/review' }] },
      { 'skills/review/SKILL.md': `${SKILL}And the tests.\n` },
    ),
  )
  const [changed] = launchExtensionContributions(dataDir).skills
  expect(readFileSync(join(changed!.dir, 'SKILL.md'), 'utf8')).toContain('And the tests.')
  expect(existsSync(first!.pluginDir)).toBe(false)

  // Added: both handed out, from one folder.
  await lifecycle.install(
    source(
      {
        skills: [
          { id: 'review', path: 'skills/review' },
          { id: 'ship', path: 'skills/ship' },
        ],
      },
      { 'skills/ship/SKILL.md': '---\nname: ship\n---\nShip it.\n' },
    ),
  )
  expect(launchExtensionContributions(dataDir).skills.map((skill) => skill.name)).toEqual([
    'local.tools.review',
    'local.tools.ship',
  ])

  // Removed by an update: retracted, its copy deleted.
  const before = launchExtensionContributions(dataDir).skills[0]!.pluginDir
  await lifecycle.install(source({ skills: [{ id: 'ship', path: 'skills/ship' }] }, { 'skills/ship/SKILL.md': 'x' }))
  const after = launchExtensionContributions(dataDir).skills
  expect(after.map((skill) => skill.name)).toEqual(['local.tools.ship'])
  expect(existsSync(join(after[0]!.pluginDir, 'skills', 'review'))).toBe(false)
  expect(existsSync(before)).toBe(false)

  // Uninstalled: nothing of it is left.
  expect(await lifecycle.uninstall(KEY)).toMatchObject({ ok: true })
  expect(projectedExtensions(dataDir)).toEqual([])
  expect(readdirSync(root).filter((name) => name !== 'state.json')).toEqual([])
})

test('a skill folder without a SKILL.md is refused at install, naming the field', async () => {
  const { start, source } = setup()
  const result = await start().install(source({ skills: [{ id: 'empty', path: 'skills/empty' }] }))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/contributes\.skills\[0\]\.path is not a folder/)
})

test('a hosted MCP server asks nothing; a change or a removal follows at once', async () => {
  const { dataDir, start, source } = setup()
  const lifecycle = start()
  expect(await lifecycle.install(source({ mcpServers: [http()] }))).toMatchObject({
    approval: { state: 'not-needed' },
  })
  expect(launchExtensionContributions(dataDir).servers).toEqual([
    expect.objectContaining({ id: 'local_tools_docs', transport: 'http', url: 'https://mcp.example.com/mcp' }),
  ])
  expect(await lifecycle.install(source({ mcpServers: [http('https://mcp.example.com/v2')] }))).toMatchObject({
    approval: { state: 'not-needed' },
  })
  expect(launchExtensionContributions(dataDir).servers[0]!.url).toBe('https://mcp.example.com/v2')
  await lifecycle.install(source({ skills: [{ id: 'review', path: 'skills/review' }] }))
  expect(launchExtensionContributions(dataDir).servers).toEqual([])
})

test('a local MCP server is approved once at install; a changed command asks again and is held back meanwhile', async () => {
  const { dataDir, moduleRoot, start, source } = setup()
  const lifecycle = start()
  const skills = [{ id: 'review', path: 'skills/review' }]
  const installed = await lifecycle.install(source({ mcpServers: [stdio()], skills }))
  expect(installed).toMatchObject({ ok: true, approval: { state: 'pending' } })
  expect(launchExtensionContributions(dataDir).servers, 'nothing runs before the approval').toEqual([])
  if (!installed.ok || installed.approval.state !== 'pending') throw new Error('expected a pending approval')
  expect(await lifecycle.approve(KEY, installed.approval.fingerprint)).toEqual({ ok: true })
  const [server] = launchExtensionContributions(dataDir).servers
  expect(server).toMatchObject({
    id: 'local_tools_search',
    transport: 'stdio',
    command: 'node',
    args: [join(moduleRoot, KEY, 'dist', 'server.js').replace(join(KEY, 'dist'), `${KEY}/dist`)],
    env: { LOG_LEVEL: 'info' },
  })
  expect(chatExtensionContributions(dataDir).mcpServers).toEqual([
    expect.objectContaining({ id: 'local_tools_search', command: 'node' }),
  ])

  // An update that changes only a skill's words keeps the approval and the server.
  const quiet = await lifecycle.install(
    source({ mcpServers: [stdio()], skills }, { 'skills/review/SKILL.md': `${SKILL}More.\n` }),
  )
  expect(quiet).toMatchObject({ approval: { state: 'approved' } })
  expect(launchExtensionContributions(dataDir).servers).toHaveLength(1)

  // Changed arguments ask again, and the server is retracted until then.
  const changed = await lifecycle.install(
    source({ mcpServers: [stdio(['${extensionPath}/dist/server.js', '--write'])] }),
  )
  expect(changed).toMatchObject({
    approval: {
      state: 'pending',
      growth: ['the local MCP server "search", with a changed command, environment or files'],
    },
  })
  expect(launchExtensionContributions(dataDir).servers).toEqual([])

  // So does the code it runs.
  if (!changed.ok || changed.approval.state !== 'pending') throw new Error('expected a pending approval')
  await lifecycle.approve(KEY, changed.approval.fingerprint)
  expect(launchExtensionContributions(dataDir).servers).toHaveLength(1)
  const recoded = await lifecycle.install(
    source(
      { mcpServers: [stdio(['${extensionPath}/dist/server.js', '--write'])] },
      { 'dist/server.js': 'console.log(2)\n' },
    ),
  )
  expect(recoded).toMatchObject({ approval: { state: 'pending' } })
  expect(launchExtensionContributions(dataDir).servers).toEqual([])
})

test('switching an extension off retracts what it hands agents; switching it on brings it back', async () => {
  const { dataDir, start, source } = setup()
  const lifecycle = start()
  await lifecycle.install(source({ mcpServers: [http()], skills: [{ id: 'review', path: 'skills/review' }] }))
  expect(launchExtensionContributions(dataDir).servers).toHaveLength(1)
  await lifecycle.setEnabled(KEY, false)
  expect(launchExtensionContributions(dataDir)).toEqual({ servers: [], skills: [] })
  await lifecycle.setEnabled(KEY, true)
  expect(launchExtensionContributions(dataDir).skills).toHaveLength(1)
})

test('a provider asks once, is known by a namespaced id, and an update to another origin asks again', async () => {
  const { dataDir, start, source } = setup()
  const lifecycle = start()
  const installed = await lifecycle.install(source({ providers: [provider()] }))
  if (!installed.ok || installed.approval.state !== 'pending') throw new Error('a provider asks')
  expect(projectedProviders(dataDir)).toEqual([])
  await lifecycle.approve(KEY, installed.approval.fingerprint)
  expect(projectedProviders(dataDir)).toEqual([
    expect.objectContaining({ id: 'local.tools/acme', localId: 'acme', baseUrl: 'https://api.example.com' }),
  ])

  // The registry lists it beside the built-ins, its key entered in Settings.
  const registry = createPluginRegistry({
    bundledRoot: join(dataDir, 'no-bundled'),
    extensionProviders: () => projectedProviders(dataDir).map(extensionProviderOf),
  })
  registry.loadSync()
  expect(registry.listConversationProviders()).toEqual([
    expect.objectContaining({ id: 'local.tools/acme', source: 'extension', credentialSource: 'api-key' }),
  ])
  const loaded = registry.getConversationProvider('local.tools/acme')
  expect(loaded?.manifest.auth).toEqual({ type: 'api-key', label: 'Acme API key' })

  const moved = await lifecycle.install(source({ providers: [provider('https://elsewhere.example.com')] }))
  expect(moved).toMatchObject({
    approval: {
      state: 'pending',
      growth: [
        'the model provider "acme" sending its key to https://elsewhere.example.com instead of https://api.example.com',
      ],
    },
  })
  expect(projectedProviders(dataDir), 'held back until approved again').toEqual([])
  expect(registry.getConversationProvider('local.tools/acme')).toBeUndefined()

  await lifecycle.uninstall(KEY)
  expect(projectedProviders(dataDir)).toEqual([])
})

test('a provider that takes a built-in’s id is refused', async () => {
  const { start, source } = setup(['openrouter'])
  const result = await start().install(source({ providers: [{ ...provider(), id: 'openrouter' }] }))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/contributes\.providers\[0\]\.id .*Studio’s own/)
})

test('a projection a crash interrupted is never read half done, and the next start puts it right', async () => {
  const { dataDir, root, start, source } = setup()
  const lifecycle = start()
  await lifecycle.install(source({ skills: [{ id: 'review', path: 'skills/review' }], mcpServers: [http()] }))
  const good = projectedExtensions(dataDir)[0]!
  const keyDir = join(root, KEY)

  // A crash while a new generation was being copied: its staging folder is
  // left beside the current one, which is what is still read.
  const staging = join(keyDir, '.staging-999-1')
  mkdirSync(join(staging, 'skills', 'review'), { recursive: true })
  writeFileSync(join(staging, 'skills', 'review', 'SKILL.md'), 'half')
  // A crash after a generation was renamed into place but before the state
  // named it: an orphan the state does not name.
  const orphan = join(keyDir, 'f'.repeat(24))
  mkdirSync(orphan, { recursive: true })
  // And a whole extension's folder the state never named.
  mkdirSync(join(root, 'local.gone', 'abc'), { recursive: true })
  expect(projectedExtensions(dataDir)).toEqual([good])

  // The next start reconciles before anything else it is asked runs.
  await start().uninstall('local.nothing')
  expect(readdirSync(keyDir)).toEqual([good.generation])
  expect(existsSync(join(root, 'local.gone'))).toBe(false)
  expect(projectedExtensions(dataDir)).toEqual([good])
})

test('a state naming a generation without its completion mark hands nothing out until it is rebuilt', async () => {
  const { dataDir, root, start, source } = setup()
  const lifecycle = start()
  await lifecycle.install(source({ skills: [{ id: 'review', path: 'skills/review' }] }))
  const { generation, pluginDir } = projectedExtensions(dataDir)[0]!
  // A folder that lost its mark (its copy was cut short and the state written
  // by hand, or the disk lost the last write): never read.
  const { rmSync } = await import('node:fs')
  rmSync(join(pluginDir!, '.complete'))
  const statePath = join(root, 'state.json')
  writeFileSync(statePath, readFileSync(statePath, 'utf8'))
  expect(readAgentContributions(dataDir).extensions).toEqual({})

  // The next start rebuilds it.
  rmSync(pluginDir!, { recursive: true, force: true })
  await start().uninstall('local.nothing')
  expect(projectedExtensions(dataDir).map((extension) => extension.generation)).toEqual([generation])
  expect(existsSync(join(pluginDir!, 'skills', 'review', 'SKILL.md'))).toBe(true)
})
