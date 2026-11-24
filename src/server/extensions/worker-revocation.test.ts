// A worker extension taken away while everything it reaches is in use: its
// process, its hooks, its MCP tools on the gateway, its local MCP server in
// the projection and in a chat already running, and a frame already drawn.
// Wired as a Studio server wires them (server-modules.ts): one lifecycle,
// one discovery, the workers, the kernel and the hooks, over one data folder,
// with real worker processes.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import type { ExtensionHookEvents } from '../../../packages/extension-sdk/src/hooks'
import { ownerInvoker } from '../../main/module-host/extension-invocation'
import { loadMainModules, type LoadMainModulesResult } from '../../main/module-host/load-modules'
import { moduleAppStateMirrorFor } from '../../main/module-host/module-app-state-mirror'
import { createExtensionApprovalReader } from '../../main/modules/extension-approvals'
import { createExtensionFrameGrant } from '../../main/modules/extension-frame-grant'
import { createModuleLifecycle, type ModuleLifecycle } from '../../main/modules/module-lifecycle'
import { createModuleRegistryMirror } from '../../main/modules/registry-mirror'
import { NO_EXTENSION_RUN } from '../../main/modules/third-party-module-view'
import { claudeExtensionServerChange } from '../../main/providers/claude-agent-provider'
import { handedExtensionServers, withdrawnExtensionServers } from '../../main/providers/extension-mcp-servers'
import { getSharedCredentialStore } from '../../main/secret-store'
import { extensionManifest, HELLO_MOUNT_SOURCE, writeExtensionFolder } from '../../../tests/extension-folder'
import { workerEntryForTests } from '../../../tests/extension-worker'
import { alive, until } from '../../../tests/extension-workers'
import { chatExtensionContributions, readAgentContributions } from './agent-contributions/projection'
import { extensionCatalogueUrls } from './catalogue/catalogue-fetch'
import { createExtensionDiscovery } from './extension-discovery'
import { frameStandingOf, installedStandingOf, planInstalledExtensions } from './extension-plan'
import { createExtensionHooks, type ExtensionHooks } from './hooks/extension-hooks'
import { ExtensionWorkers } from './workers/worker-manager'

const KEY = 'local.guard'

// Its worker answers a method with its pid, serves an MCP tool, and refuses
// any prompt that says "forbidden".
const MAIN = `exports.activate = (studio) => {
  studio.registerMethods({
    pid: { access: 'read', params: (v) => ({ ok: true, params: v }), handler: () => ({ ok: true, result: process.pid }) },
  })
  studio.registerMcpTools([{ name: 'guard_ping', description: 'Ping', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }) }])
  studio.registerHooks({
    'agent.prompt.before': (event) => (String(event.prompt).includes('forbidden') ? { deny: 'it is forbidden.' } : undefined),
  })
}
`

function guardFolder(dir: string, version = '1.0.0'): string {
  return writeExtensionFolder(dir, {
    manifest: extensionManifest({
      id: 'guard',
      name: 'Guard',
      version,
      permissions: ['storage:own', 'settings:own', 'secrets:own', 'tools:contribute'],
      contributes: {
        doors: [{ id: 'panel', title: 'Guard', entry: 'dist/door.js' }],
        hooks: [{ point: 'agent.prompt.before', onError: 'deny' }],
        mcpTools: [
          {
            name: 'guard_ping',
            description: 'Ping',
            access: 'read',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
        mcpServers: [
          {
            id: 'search',
            name: 'Search',
            transport: 'stdio',
            command: 'node',
            args: ['${extensionPath}/dist/server.js'],
          },
        ],
        providers: [
          {
            id: 'models',
            name: 'Guard models',
            baseUrl: 'https://api.example.com',
            models: [{ id: 'guard-large' }],
            apiKey: { label: 'Guard API key' },
          },
        ],
        settings: [{ key: 'level', title: 'Level', type: 'string', default: 'low' }],
      },
    }),
    files: {
      'dist/main.cjs': MAIN,
      'dist/door.js': HELLO_MOUNT_SOURCE,
      'dist/server.js': 'process.stdin.resume()\n',
    },
  })
}

type Studio = {
  dataDir: string
  scratch: string
  lifecycle: ModuleLifecycle
  serveKillList(extensions: unknown[]): void
  /** Start the server's half over what is installed now, as a Studio does at its start. */
  start(): Promise<{ load: LoadMainModulesResult; workers: ExtensionWorkers; hooks: ExtensionHooks }>
  close(): Promise<void>
}

const studios: Studio[] = []
afterEach(async () => {
  for (const studio of studios.splice(0)) await studio.close()
  vi.restoreAllMocks()
})

function studioFor(): Studio {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worker-revocation-')))
  const dataDir = join(scratch, 'data')
  const moduleRoot = join(scratch, 'extensions')
  mkdirSync(dataDir, { recursive: true })
  const urls = extensionCatalogueUrls('https://catalogue.example.com/main')
  const served = new Map<string, unknown>([
    [urls.killList, { killListVersion: 1, generatedAt: '2026-11-19T00:00:00Z', extensions: [] }],
  ])
  const discovery = createExtensionDiscovery({ moduleRoot: () => moduleRoot, dataDir })
  let workers: ExtensionWorkers | null = null
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => moduleRoot,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    // What server-modules.ts does: read the disk again, and stop a worker that may not run now.
    changed: () => {
      discovery.invalidate()
      workers?.reconcile()
    },
    run: () => NO_EXTENSION_RUN,
    registry: createModuleRegistryMirror(),
    catalogue: {
      urls,
      fetchJson: async (url) => {
        if (!served.has(url)) throw new Error(`${url} answered HTTP 404.`)
        return JSON.parse(JSON.stringify(served.get(url)))
      },
    },
  })
  const studio: Studio = {
    dataDir,
    scratch,
    lifecycle,
    serveKillList: (extensions) =>
      served.set(urls.killList, { killListVersion: 1, generatedAt: '2026-11-21T00:00:00Z', extensions }),
    async start() {
      const approvals = createExtensionApprovalReader(dataDir)
      let kernel: LoadMainModulesResult['kernel'] | null = null
      workers = new ExtensionWorkers({
        entryPath: workerEntryForTests(),
        logDir: join(scratch, 'logs'),
        approvals,
        installed: () => installedStandingOf(discovery.current()),
        gate: (moduleId, method) => kernel!.gateHostMethod(moduleId, method),
        toolNameProblem: (moduleId, names) => kernel!.mcpToolNameProblem(moduleId, names),
        notify: () => undefined,
        idleReapMs: 0,
      })
      const plan = planInstalledExtensions(discovery.current(), () => workers!)
      const load = loadMainModules({
        modules: plan.modules,
        moduleRoots: plan.moduleRoots,
        moduleVerifiedFiles: plan.verifiedFiles,
        moduleMcpTools: plan.mcpTools,
        extensionApprovals: plan.approvals,
        currentApprovals: approvals,
        resolveFrameGrant: createExtensionFrameGrant({
          approvals,
          dataDir,
          standing: (moduleId) => frameStandingOf(discovery.current(), moduleId),
          // A folder changed where no watcher heard it: discovery reads it again.
          refresh: () => discovery.invalidate(),
        }),
        ineligible: plan.ineligible,
        launchErrors: plan.launchErrors,
        onKernel: (made) => {
          kernel = made
          made.attachWorkers(workers!)
        },
      })
      await load.ready
      const hooks = createExtensionHooks()
      hooks.bind(workers)
      return { load, workers, hooks }
    },
    close: async () => {
      await workers?.close()
      await lifecycle.catalogue.dispose()
    },
  }
  studios.push(studio)
  return studio
}

async function installApproved(studio: Studio, source: string): Promise<void> {
  const installed = await studio.lifecycle.install(source)
  assert.ok(installed.ok && installed.approval.state === 'pending', JSON.stringify(installed))
  assert.deepEqual(await studio.lifecycle.approve(KEY, installed.approval.fingerprint), { ok: true })
}

const prompt = (text: string): ExtensionHookEvents['agent.prompt.before'] => ({
  agent: 'claude-agent',
  where: 'chat',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  terminalId: null,
  from: 'studio',
  inputKind: 'send',
  prompt: text,
})

test('a worker extension killed while in use stops everywhere: its process, hooks, tools, local server, live chats and open frames', async () => {
  const studio = studioFor()
  await installApproved(studio, guardFolder(join(studio.scratch, 'src', 'guard')))
  const { load, workers, hooks } = await studio.start()

  // In use: its worker runs, its hook decides, its tool is on the gateway,
  // its local server is handed to chats, and a frame of its panel is open.
  const called = await load.kernel.callModuleMethod({
    moduleId: KEY,
    method: 'pid',
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
  assert.ok(called.ok && called.answer.ok, JSON.stringify(called))
  const pid = called.answer.result as number
  assert.ok(alive(pid))
  assert.equal(hooks.wants('agent.prompt.before'), true)
  assert.equal((await hooks.run('agent.prompt.before', prompt('a forbidden thing'), ownerInvoker())).kind, 'deny')
  assert.deepEqual(
    load.kernel.mcpToolRegistrations().map((tool) => tool.registration.name),
    ['guard_ping'],
  )
  const servers = chatExtensionContributions(studio.dataDir).mcpServers
  assert.deepEqual(
    servers.map((server) => server.id),
    ['local_guard_search'],
  )
  // A Claude chat and a Codex chat started with it.
  const claudeStarted = { handed: handedExtensionServers(servers), commandLine: new Set<string>() }
  const codexStarted = handedExtensionServers(servers)
  const frame = await studio.lifecycle.frame({ moduleId: KEY, point: 'doors', id: 'panel' })
  assert.ok(frame.ok)
  const frameCall = () =>
    load.kernel.callFrameMethod({
      moduleId: KEY,
      frame: frame.hash,
      method: 'log.write',
      params: { level: 'info', message: 'still here' },
      clientId: 'c',
      commandId: 'k',
      invoker: ownerInvoker(),
    })
  assert.deepEqual(await frameCall(), { ok: true, result: { ok: true } })

  // The kill list names it.
  studio.serveKillList([{ id: KEY, reason: 'It sends your files away.' }])
  await studio.lifecycle.catalogue.killList.refresh()

  await until(() => !alive(pid), 10_000, 'its process to stop')
  assert.equal(workers.status(KEY)?.state, 'stopped')
  assert.equal(hooks.wants('agent.prompt.before'), false, 'its hook no longer fires')
  assert.equal((await hooks.run('agent.prompt.before', prompt('a forbidden thing'), ownerInvoker())).kind, 'continue')
  assert.deepEqual(load.kernel.mcpToolRegistrations(), [], 'its tool left the gateway')
  assert.deepEqual(readAgentContributions(studio.dataDir).extensions, {}, 'retracted from the projection')
  assert.deepEqual(chatExtensionContributions(studio.dataDir).mcpServers, [])
  // A live chat drops it before its next turn.
  const now = chatExtensionContributions(studio.dataDir).mcpServers
  assert.deepEqual(claudeExtensionServerChange(claudeStarted, [], now), {
    kind: 'reconfigure',
    control: {},
    handed: handedExtensionServers([]),
  })
  assert.deepEqual(withdrawnExtensionServers(codexStarted, handedExtensionServers(now)), ['local_guard_search'])
  // Its open frame is refused.
  const refused = await frameCall()
  assert.equal(!refused.ok && refused.code, 'approval_required')
  // And it does not start again for a call.
  const again = await load.kernel.callModuleMethod({
    moduleId: KEY,
    method: 'pid',
    access: 'read',
    params: {},
    clientId: 'test',
    invoker: ownerInvoker(),
  })
  assert.equal(again.ok && again.answer.ok, false)
})

test('uninstalling a worker with hooks, a local server, settings, secrets, storage and provider keys forgets all of it, and a reinstall inherits nothing', async () => {
  const studio = studioFor()
  const forgotten = vi.spyOn(getSharedCredentialStore(), 'forgetUnder')
  await installApproved(studio, guardFolder(join(studio.scratch, 'src', 'guard')))
  // What it kept here while it was installed.
  moduleAppStateMirrorFor(studio.dataDir).setValue(KEY, 'level', 'high')
  mkdirSync(join(studio.dataDir, 'module-secrets'), { recursive: true })
  writeFileSync(join(studio.dataDir, 'module-secrets', `${KEY}.bin`), 'sealed')
  mkdirSync(join(studio.dataDir, 'module-storage', KEY), { recursive: true })
  writeFileSync(join(studio.dataDir, 'module-storage', KEY, 'notes.json'), '{}')
  const { load, workers, hooks } = await studio.start()
  await hooks.run('agent.prompt.before', prompt('hello'), ownerInvoker())
  const pid = workers.status(KEY)?.pid
  assert.ok(alive(pid))

  assert.deepEqual(await studio.lifecycle.uninstall(KEY), { ok: true, removedModuleIds: [KEY] })
  await until(() => !alive(pid), 10_000, 'its process to stop')
  assert.equal(hooks.wants('agent.prompt.before'), false)
  assert.deepEqual(load.kernel.mcpToolRegistrations(), [])
  assert.deepEqual(chatExtensionContributions(studio.dataDir).mcpServers, [])
  assert.deepEqual(moduleAppStateMirrorFor(studio.dataDir).get(KEY), {})
  assert.equal(existsSync(join(studio.dataDir, 'module-secrets', `${KEY}.bin`)), false)
  assert.equal(existsSync(join(studio.dataDir, 'module-storage', KEY)), false)
  assert.deepEqual(forgotten.mock.calls, [[`${KEY}/`]], 'its provider keys')

  // Another folder installed under the same key starts with nothing, and asks again.
  const reinstalled = await studio.lifecycle.install(guardFolder(join(studio.scratch, 'elsewhere', 'guard'), '2.0.0'))
  assert.ok(reinstalled.ok)
  assert.equal(reinstalled.approval.state, 'pending')
  assert.deepEqual(await studio.lifecycle.settings(KEY), { ok: true, values: { level: 'low' } })
  assert.equal(existsSync(join(studio.dataDir, 'module-storage', KEY)), false)
})

test('removing a development folder forgets what was kept for it, but never an installed extension’s under the same key', async () => {
  const studio = studioFor()
  const work = join(studio.scratch, 'work')
  const store = moduleAppStateMirrorFor(studio.dataDir)

  // A folder of its own key: removing it forgets its Settings values and storage.
  const folder = guardFolder(join(work, 'guard'))
  const loaded = await studio.lifecycle.devLoad(folder)
  assert.ok(loaded.ok)
  const devKey = loaded.moduleId
  store.setValue(devKey, 'level', 'high')
  mkdirSync(join(studio.dataDir, 'module-storage', devKey), { recursive: true })
  assert.deepEqual(await studio.lifecycle.devUnload({ path: folder }), { ok: true, path: folder, moduleId: devKey })
  assert.deepEqual(store.get(devKey), {})
  assert.equal(existsSync(join(studio.dataDir, 'module-storage', devKey)), false)

  // A folder standing in for an installed extension shares its key: the installed one's values stay.
  await installApproved(studio, guardFolder(join(studio.scratch, 'src', 'guard')))
  store.setValue(KEY, 'level', 'high')
  const over = guardFolder(join(work, 'over'))
  const standing = await studio.lifecycle.devLoad(over)
  assert.ok(standing.ok && standing.moduleId === KEY, JSON.stringify(standing))
  assert.equal((await studio.lifecycle.devUnload({ path: over })).ok, true)
  assert.deepEqual(store.get(KEY), { level: 'high' })
})
