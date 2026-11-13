import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, test, vi } from 'vitest'

import { connectToStudio } from '../../packages/agent-sdk/src/node'
import type { StudioClient } from '../../packages/client-runtime/src/public'
import { validateThirdPartyModuleManifest } from '../../packages/module-sdk/src/manifest-validate'
import type { ModuleMethodContracts } from '../../packages/module-sdk/src/methods'
import { generateModuleSigningKeyPair, signManifest } from '../../packages/module-sdk/src/signing'
import type { StudioModuleEvent, StudioModuleSummary } from '../../packages/studio-protocol/src/public'
import { createConversationLaunchService } from '../main/conversation-launch-service'
import { ConversationRuntime } from '../main/conversation-runtime'
import { readModuleOverridesSync } from '../main/module-host/enablement-store'
import { loadMainModules } from '../main/module-host/load-modules'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from '../main/modules/agent-runtime-module'
import { applyHostApiGate } from '../main/modules/host-api-gate'
import { createModuleLifecycle, liveModuleIds } from '../main/modules/module-lifecycle'
import { computeModuleFileDigestsSync } from '../main/modules/module-signature'
import { planThirdPartyMainModules } from '../main/modules/third-party-main-loader'
import { readModuleTrustContextSync } from '../main/modules/trust-context'
import { discoverUserModulesSync } from '../main/modules/user-module-registry'
import { createWorkspaceRegistryService } from '../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../main/workspace-sync-service'
import { createRendererHost } from '../renderer/src/modules/renderer-host'
import { moduleLifecycleOver } from '../renderer/src/studio/moduleLifecycle'
import { callModuleMethod } from '../renderer/src/studio/moduleMethods'
import type { Workspace } from '../renderer/src/types/workspace'
import { createNodeStudioPaths } from '../server/platform/studio-paths'
import { createStudioModuleHub } from '../server/rpc/studio-modules'
import { OWNER_TOKEN, pairFakeClient, startTestServer } from '../server/rpc/studio-rpc.test-helper'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { HOST_API_VERSION } from '../shared/modules/host-api'
import type { CapabilityManifest } from '../shared/modules/manifest'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
import { createSecretCipherStandIn } from '../../tests/stubs/secret-cipher'

vi.mock('electron', () => import('../../tests/stubs/electron'))

// An extension's whole life on its server, from a window, over the Studio
// protocol alone:
//
//   window: Settings' lifecycle calls, a module's renderer host
//     ─ owner socket ─ router ─ module hub ─ lifecycle and kernel ─ disk
//
// An extension built for host API 2 and signed by a test key (never the
// release key) is installed from a folder and trusted through the server; at
// the server's next start it runs: the window calls its declared methods and
// hears its events. Switched off, it is gone at once: its calls are refused
// `module_unavailable`, the list says it is not running and declares nothing,
// and it says nothing more. Switched on again, it answers again.
//
// An extension drives a chat the same way: the window calls its methods, it
// creates, follows and sends to a chat of its own through the agent runtime's
// conversation service, and the window hears the chat's answer as its events.
// A retried call (the same command id, on a new connection or after the
// server restarts) sends once. And another extension cannot reach that chat
// by naming the first one's id to the service.
//
// The server is composed as the Studio's out-of-process one composes its
// modules (server-modules.ts) over a scratch data folder and module root:
// discovery, the trust and host-API gates, the agent runtime, the kernel, the
// hub and the lifecycle. The chats beneath the agent runtime (the workspace
// registry and bus, the launch service, the conversation runtime) outlive
// each start, as the core and its chat logs do, with a stand-in provider as
// the only fake. The core's schedules are left out.

const scratch = mkdtempSync(join(tmpdir(), 'studio-module-lifecycle-'))
const dataDir = join(scratch, 'data')
const moduleRoot = join(scratch, 'modules')
const source = join(scratch, 'source', 'deck')
const project = join(scratch, 'project')
mkdirSync(dataDir, { recursive: true })
mkdirSync(moduleRoot, { recursive: true })
mkdirSync(project, { recursive: true })

const cleanups: Array<() => unknown> = []
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

const ID = 'acme-deck'

/** An extension as its author ships it, at host API 2, signed as `sprintengine-module sign` signs by a test key. */
function writeSigned(folder: string, manifestFields: Record<string, unknown>, main: string): void {
  mkdirSync(join(folder, 'dist'), { recursive: true })
  writeFileSync(join(folder, 'dist', 'main.cjs'), main)
  const digests = computeModuleFileDigestsSync(folder)
  assert.ok(digests.ok, 'the extension’s files are digested')
  const manifest = {
    version: 1,
    defaultEnabled: true,
    engines: { hostApi: HOST_API_VERSION },
    entry: { main: 'dist/main.cjs' },
    ...manifestFields,
    files: digests.files,
  }
  // Signed over the manifest as the validator reads it, by a key made for
  // this test: never the release key.
  const validated = validateThirdPartyModuleManifest(manifest)
  assert.ok(validated.ok, 'the manifest is valid')
  const signer = generateModuleSigningKeyPair()
  writeFileSync(
    join(folder, 'manifest.json'),
    JSON.stringify({ ...manifest, signature: signManifest(validated.manifest, signer.privateKeyPem) }),
  )
}

/** The deck: declared methods, an event on each card. */
function writeSignedExtension(): void {
  writeSigned(
    source,
    { id: ID, displayName: 'Deck', permissions: ['module:bridge'] },
    `const cards = []
exports.registerMain = (host) => {
  host.registerMethods({
    'cards.list': { access: 'read', params: () => ({ ok: true, params: {} }), handler: () => ({ ok: true, result: cards }) },
    'cards.add': {
      access: 'operate',
      params: (value) =>
        value && typeof value.title === 'string'
          ? { ok: true, params: { title: value.title } }
          : { ok: false, message: '"title" is the card\\'s title.' },
      handler: (params, context) => {
        cards.push(params.title)
        host.emit('cards.changed', { count: cards.length, commandId: context.commandId ?? null })
        return { ok: true, result: { count: cards.length } }
      },
    },
  })
}
`,
  )
}

/**
 * What the agent runtime runs chats on, kept across the server's starts as
 * the core is: a workspace on the bus, the launch service, and the runtime
 * over a stand-in provider that answers each turn with an echo and counts
 * the turns it was sent.
 */
function createChats() {
  const workspace: Workspace = {
    id: 'ws-a',
    name: 'ws-a',
    mode: 'standard',
    folderPath: project,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: [toWorkspaceRegistryRecord(workspace, 1)],
    }),
    now: () => 1000,
  })
  const sync = createWorkspaceSyncService({ registry, now: () => 1000 })
  const turns: string[] = []
  const event = (
    base: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
    type: ConversationEventType,
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({ id: '', ...base, type, createdAt: 0, payload })
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    adapters: [
      {
        id: 'claude-agent',
        displayName: 'Claude Code',
        sessions: 'stateful',
        listModels: () => ['default'],
        startSession: (input) => [event(input, 'session_started'), event(input, 'session_ready')],
        async *sendTurn(input) {
          turns.push(input.message)
          yield event(input, 'turn_started', { turnId: input.turnId })
          yield event(input, 'content_delta', { turnId: input.turnId, text: `re: ${input.message}` })
          yield event(input, 'turn_completed', { turnId: input.turnId })
        },
        resolveApproval: () => [],
        setPermissionPreset: async () => ({ ok: true }),
        interrupt: () => [],
        stopSession: (input) => [event(input, 'session_closed')],
      },
    ],
  })
  cleanups.push(() => runtime.shutdown())
  const launchService = createConversationLaunchService({
    getWorkspace: (id) => registry.getRecord(id),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (workspaceId, agentId, agent) => sync.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => registry.getRecords(),
    createWorkspace: (request) => {
      const created = sync.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => sync.removeWorkspace(workspaceId, 'system'),
    startSession: (input) => runtime.startSession(input),
    send: (input) => runtime.sendTurn(input),
  })
  return {
    turns,
    services: {
      conversationLaunchService: launchService,
      conversationRuntime: runtime,
      conversations: runtime,
      workspaceSyncService: sync,
      workspaceRegistry: registry,
      agentLaunchSettings: { get: () => emptyAgentLaunchSettings() },
      githubTokenStore: { resolveToken: async () => '' },
    },
  }
}

let sharedChats: ReturnType<typeof createChats> | null = null
const chats = () => (sharedChats ??= createChats())

/** One start of the server: what is on disk now, loaded, and served on a socket of its own. */
async function startServer() {
  const thirdParty = planThirdPartyMainModules(
    discoverUserModulesSync(moduleRoot, readModuleTrustContextSync(dataDir)),
    { electronMain: false },
  )
  applyHostApiGate(thirdParty.ineligible, thirdParty.modules)
  const hub = createStudioModuleHub()
  const byId = new Map<string, CapabilityManifest>(
    [AGENT_RUNTIME_MANIFEST, ...thirdParty.modules.map((module) => module.manifest)].map((manifest) => [
      manifest.id,
      manifest,
    ]),
  )
  const agentRuntime = createAgentRuntimeModule(chats().services as never, {
    getModulePermissions: (moduleId) => byId.get(moduleId)?.permissions,
    platform: {
      paths: createNodeStudioPaths({ dataDir, packaged: false }),
      secrets: createSecretCipherStandIn({ value: false }),
    },
  })
  const load = loadMainModules({
    modules: [agentRuntime, ...thirdParty.modules],
    overrides: readModuleOverridesSync(dataDir),
    moduleRoots: thirdParty.moduleRoots,
    moduleVerifiedFiles: thirdParty.verifiedFiles,
    ineligible: thirdParty.ineligible,
    launchErrors: thirdParty.launchErrors,
    deliverModuleEvent: (event) => hub.deliverEvent(event),
    electronMain: false,
  })
  await load.ready
  const manifests = thirdParty.modules.map((module) => module.manifest)
  hub.serveCallsFrom((request) => load.kernel.callModuleMethod(request))
  hub.serveHostServicesFrom((moduleId) => load.kernel.hostServicesFor(moduleId))
  hub.serveLifecycleFrom(
    createModuleLifecycle({
      dataDir,
      moduleRoot: () => moduleRoot,
      changed: () => undefined,
      applyEnablement: async (overrides) => {
        await load.applyEnablement(overrides, {
          liveModuleIds: liveModuleIds(Object.keys(thirdParty.moduleRoots), load.report.errors),
        })
        return { ok: true }
      },
      view: () => {
        const overrides = readModuleOverridesSync(dataDir)
        return {
          manifests: () => manifests,
          enabled: (id) => overrides[id] ?? manifests.find((manifest) => manifest.id === id)?.defaultEnabled ?? false,
          running: (id) => load.isRunning(id),
          ineligible: (id) => thirdParty.ineligible[id],
          loadError: (id) => load.report.errors.find((error) => error.id === id)?.message,
          declaredMethods: (id) => load.kernel.declaredMethods(id),
        }
      },
    }),
  )
  const started = await startTestServer({ modules: hub })
  const stop = async () => {
    await started.dispose()
    await load.kernel.runShutdown()
  }
  cleanups.push(stop)
  return { path: started.path, auth: started.auth, stop }
}

/** A window's connection to that server, as its owner. */
async function windowOn(path: string, token = OWNER_TOKEN): Promise<StudioClient> {
  const client = await connectToStudio({ name: 'window', token, socketPath: path })
  cleanups.push(() => client.close())
  return client
}

async function listed(client: StudioClient): Promise<StudioModuleSummary | undefined> {
  return (await client.request('module.list', {})).modules.find((module) => module.id === ID)
}

/** What `count` events have been heard so far, waiting a little for one still on its way. */
async function heard(events: StudioModuleEvent[], count: number): Promise<StudioModuleEvent[]> {
  for (let tries = 0; events.length < count && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  return events
}

test('an extension is installed, trusted, called, heard, switched off and on again through its server', async () => {
  writeSignedExtension()

  // ── Installed and trusted through the server ────────────────────────────
  const first = await startServer()
  const settings = await windowOn(first.path)
  const lifecycle = moduleLifecycleOver(async () => settings)
  const installed = await lifecycle.install(source)
  assert.deepEqual(installed, { ok: true, moduleId: ID, trust: 'signed' }, 'a test key is not a trusted publisher')
  assert.deepEqual(await lifecycle.setTrust(ID, true), { ok: true })
  assert.equal(await listed(settings), undefined, 'what is installed loads at the next start')
  await first.stop()

  // ── At the next start it runs, and a window calls it and hears it ───────
  const second = await startServer()
  const client = await windowOn(second.path)
  const running = await listed(client)
  assert.deepEqual(running && { enabled: running.enabled, running: running.running, methods: running.methods }, {
    enabled: true,
    running: true,
    methods: [
      { name: 'cards.list', access: 'read' },
      { name: 'cards.add', access: 'operate' },
    ],
  })
  assert.equal(running?.source, 'third-party')

  const events: StudioModuleEvent[] = []
  client.subscribe('module.events', { moduleId: ID }, { onPayload: (event) => events.push(event) })
  // The window's renderer half of the extension, calling its own server.
  const renderer = createRendererHost()
  renderer.setModuleMethodCaller((call) => callModuleMethod(client, call))
  const manifest = { id: ID, displayName: 'Deck', version: 1, defaultEnabled: true, source: 'third-party' }
  const deck = renderer.hostFor(ID, manifest as CapabilityManifest).methods<{
    'cards.list': { access: 'read'; params: Record<string, never>; result: string[] }
    'cards.add': { access: 'operate'; params: { title: string }; result: { count: number } }
  }>()
  // The stream is up once a first event comes through it.
  for (let tries = 0; events.length === 0 && tries < 50; tries++) {
    await deck.operate('cards.add', { title: `Warm-up ${tries}` })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(events.length > 0, 'the window hears the extension’s events')
  const before = (await deck.read('cards.list', {})) as { ok: true; result: string[] }
  assert.equal(before.ok, true)

  const added = await deck.operate('cards.add', { title: 'Ship it' }, { commandId: 'add-ship-it' })
  assert.deepEqual(added, { ok: true, result: { count: before.result.length + 1 } })
  const afterAdd = await heard(events, events.length + 1)
  const last = afterAdd.at(-1)!
  assert.equal(last.sourceModuleId, ID)
  assert.equal(last.topic, 'cards.changed')
  assert.deepEqual(last.payload, { count: before.result.length + 1, commandId: 'owner:add-ship-it' })
  const refused = await deck.operate('cards.add', { name: 'x' } as unknown as { title: string })
  assert.equal(!refused.ok && refused.code, 'invalid_params', 'its own validator reads the params')

  // ── Switched off: gone at once ──────────────────────────────────────────
  const off = await moduleLifecycleOver(async () => client).setEnabled(ID, false)
  assert.equal(off.ok, true, off.ok ? '' : off.message)
  assert.deepEqual(off.ok && off.module && { enabled: off.module.enabled, running: off.module.running }, {
    enabled: false,
    running: false,
  })
  const gone = await listed(client)
  assert.deepEqual(gone && { enabled: gone.enabled, running: gone.running, methods: gone.methods }, {
    enabled: false,
    running: false,
    methods: [],
  })
  const unavailable = await deck.read('cards.list', {})
  assert.equal(!unavailable.ok && unavailable.code, 'module_unavailable')
  const quiet = events.length
  assert.equal(!(await deck.operate('cards.add', { title: 'Nobody' })).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(events.length, quiet, 'a switched-off extension says nothing')
  assert.deepEqual(readModuleOverridesSync(dataDir), { [ID]: false }, 'the choice is kept for the next start')

  // ── Switched on again: it answers again ─────────────────────────────────
  const on = await moduleLifecycleOver(async () => client).setEnabled(ID, null)
  assert.equal(on.ok && on.module?.running, true)
  const again = await deck.read('cards.list', {})
  assert.equal(again.ok, true)
  assert.deepEqual(readModuleOverridesSync(dataDir), {}, 'null is back to its default')
})

test('only an owner changes what runs: a paired client granted modules may list, and is refused the rest', async () => {
  const { path, auth } = await startServer()
  const paired = await windowOn(path, pairFakeClient(auth, 'tablet', ['modules:operate']))
  const modules = (await paired.request('module.list', {})).modules
  assert.equal(
    modules.find((module) => module.id === ID)?.running,
    true,
    'it lists what runs, the extension switched back on above',
  )
  const lifecycle = moduleLifecycleOver(async () => paired)
  for (const refused of [
    await lifecycle.setEnabled(ID, false),
    await lifecycle.setTrust(ID, false),
    await lifecycle.uninstall(ID),
    await lifecycle.install(source),
  ]) {
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.message, /owner|Studio’s own/i)
  }
  assert.deepEqual(readModuleOverridesSync(dataDir), {}, 'nothing it asked for was written')
})

const CHAT_ID = 'acme-chat'
const SNOOP_ID = 'acme-snoop'

/**
 * An extension that drives a chat of its own through the conversation
 * service, as the SDK's `getConversationService` reaches it: it starts one,
 * follows it (each answer is an event the window hears), and sends to it,
 * passing on each call's command id. `chat.sendThenFail` sends without it and
 * then throws, as a handler with a bug past its send would.
 */
const CHAT_MAIN = `exports.registerMain = (host) => {
  const chats = host.requireService({ key: 'conversation.module-service' })
  const followed = new Set()
  const follow = (ref) => {
    if (followed.has(ref.agentId)) return
    followed.add(ref.agentId)
    chats.subscribe(host.moduleId, ref, (event) => {
      if (event.type === 'content_delta') host.emit('chat.said', { agentId: event.agentId, text: String(event.payload.text) })
    })
  }
  const toSend = (value) =>
    value && typeof value.workspaceId === 'string' && typeof value.agentId === 'string' && typeof value.message === 'string'
      ? { ok: true, params: { workspaceId: value.workspaceId, agentId: value.agentId, message: value.message } }
      : { ok: false, message: 'A chat (workspaceId, agentId) and a message.' }
  const answer = (outcome, result) => (outcome.ok ? { ok: true, result } : { ok: false, code: outcome.code, message: outcome.message })
  host.registerMethods({
    'chat.start': {
      access: 'operate',
      params: () => ({ ok: true, params: {} }),
      handler: async (_params, context) => {
        const created = await chats.create(host.moduleId, { workspaceId: 'ws-a', cli: 'claude-code', commandId: context.commandId })
        if (!created.ok) return answer(created)
        const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
        follow(ref)
        return { ok: true, result: ref }
      },
    },
    'chat.send': {
      access: 'operate',
      params: toSend,
      handler: async (params, context) => {
        const ref = { workspaceId: params.workspaceId, agentId: params.agentId }
        follow(ref)
        return answer(await chats.send(host.moduleId, ref, { message: params.message, commandId: context.commandId }), { sent: true })
      },
    },
    'chat.sendThenFail': {
      access: 'operate',
      params: toSend,
      handler: async (params) => {
        await chats.send(host.moduleId, { workspaceId: params.workspaceId, agentId: params.agentId }, { message: params.message })
        throw new Error('The handler failed after it sent.')
      },
    },
  })
}
`

/** An extension that declares no chat permission and tries to send to another extension's chat as that extension. */
const SNOOP_MAIN = `exports.registerMain = (host) => {
  host.registerMethods({
    'chat.sendAs': {
      access: 'operate',
      params: (value) => ({ ok: true, params: value }),
      handler: async (params) => {
        const chats = host.requireService({ key: 'conversation.module-service' })
        const sent = await chats.send(params.as, { workspaceId: params.workspaceId, agentId: params.agentId }, { message: 'from the snoop' })
        return { ok: true, result: { sent: sent.ok } }
      },
    },
  })
}
`

type ChatRef = { workspaceId: string; agentId: string }
type ChatMethods = {
  'chat.start': { access: 'operate'; params: Record<string, never>; result: ChatRef }
  'chat.send': { access: 'operate'; params: ChatRef & { message: string }; result: { sent: true } }
  'chat.sendThenFail': { access: 'operate'; params: ChatRef & { message: string }; result: { sent: true } }
}

/** A module's methods as its renderer half calls them, over this client. */
function methodsOn<Cs extends ModuleMethodContracts>(client: StudioClient, id: string) {
  const renderer = createRendererHost()
  renderer.setModuleMethodCaller((call) => callModuleMethod(client, call))
  const manifest = { id, displayName: id, version: 1, defaultEnabled: true, source: 'third-party' }
  return renderer.hostFor(id, manifest as CapabilityManifest).methods<Cs>()
}

test('an extension drives a chat through its server, and a retried call sends once', async () => {
  const chatSource = join(scratch, 'source', 'chat')
  const snoopSource = join(scratch, 'source', 'snoop')
  writeSigned(
    chatSource,
    {
      id: CHAT_ID,
      displayName: 'Chat',
      permissions: ['module:bridge', 'conversation:operate'],
      dependsOn: ['agent-runtime'],
    },
    CHAT_MAIN,
  )
  writeSigned(snoopSource, { id: SNOOP_ID, displayName: 'Snoop', permissions: ['module:bridge'] }, SNOOP_MAIN)
  const { turns } = chats()

  // ── Installed and trusted through the server, running at its next start ──
  const first = await startServer()
  const settings = moduleLifecycleOver(async () => windowOn(first.path))
  for (const [folder, id] of [
    [chatSource, CHAT_ID],
    [snoopSource, SNOOP_ID],
  ] as const) {
    assert.deepEqual(await settings.install(folder), { ok: true, moduleId: id, trust: 'signed' })
    assert.deepEqual(await settings.setTrust(id, true), { ok: true })
  }
  await first.stop()

  const second = await startServer()
  const client = await windowOn(second.path)
  const said: StudioModuleEvent[] = []
  client.subscribe('module.events', { moduleId: CHAT_ID }, { onPayload: (event) => said.push(event) })
  const chat = methodsOn<ChatMethods>(client, CHAT_ID)

  // ── It starts a chat, follows it and sends to it; the window hears the answer ──
  const started = await chat.operate('chat.start', {}, { commandId: 'start' })
  assert.equal(started.ok, true, JSON.stringify(started))
  if (!started.ok) return
  const ref = started.result
  assert.deepEqual(
    await chat.operate('chat.start', {}, { commandId: 'start' }),
    started,
    'a retried start is that chat',
  )
  const sent = await chat.operate('chat.send', { ...ref, message: 'hello' }, { commandId: 'hello' })
  assert.deepEqual(sent, { ok: true, result: { sent: true } })
  for (
    let tries = 0;
    !said.some((event) => (event.payload as { text?: string }).text === 're: hello') && tries < 100;
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  const answer = said.find((event) => (event.payload as { text?: string }).text === 're: hello')
  assert.deepEqual(answer && { topic: answer.topic, payload: answer.payload }, {
    topic: 'chat.said',
    payload: { agentId: ref.agentId, text: 're: hello' },
  })
  assert.deepEqual(turns, ['hello'])

  // ── A retry sends nothing more: on a new connection, and racing the first ──
  const reconnected = methodsOn<ChatMethods>(await windowOn(second.path), CHAT_ID)
  assert.deepEqual(await reconnected.operate('chat.send', { ...ref, message: 'hello' }, { commandId: 'hello' }), sent)
  const racing = await Promise.all([
    chat.operate('chat.send', { ...ref, message: 'twice' }, { commandId: 'twice' }),
    reconnected.operate('chat.send', { ...ref, message: 'twice' }, { commandId: 'twice' }),
  ])
  assert.deepEqual(racing, [sent, sent])
  // The longest id the protocol takes still reaches the chat, namespaced by the client.
  const longest = 'x'.repeat(200)
  assert.deepEqual(await chat.operate('chat.send', { ...ref, message: 'long' }, { commandId: longest }), sent)
  assert.deepEqual(await reconnected.operate('chat.send', { ...ref, message: 'long' }, { commandId: longest }), sent)
  // A handler that threw after it sent is not run again under that id.
  const failed = await chat.operate('chat.sendThenFail', { ...ref, message: 'once' }, { commandId: 'fails' })
  assert.equal(failed.ok, false)
  assert.deepEqual(
    await reconnected.operate('chat.sendThenFail', { ...ref, message: 'once' }, { commandId: 'fails' }),
    failed,
  )
  assert.deepEqual(turns, ['hello', 'twice', 'long', 'once'])
  await second.stop()

  // ── After a restart the server has forgotten its answers; the chat's receipt still answers ──
  const third = await startServer()
  const after = await windowOn(third.path)
  assert.deepEqual(
    await methodsOn<ChatMethods>(after, CHAT_ID).operate(
      'chat.send',
      { ...ref, message: 'hello' },
      { commandId: 'hello' },
    ),
    sent,
  )
  assert.deepEqual(turns, ['hello', 'twice', 'long', 'once'])

  // ── Another extension cannot send to that chat by naming the first one ──
  const snoop = methodsOn<{
    'chat.sendAs': { access: 'operate'; params: ChatRef & { as: string }; result: { sent: boolean } }
  }>(after, SNOOP_ID)
  const snooped = await snoop.operate('chat.sendAs', { ...ref, as: CHAT_ID })
  // The kernel refuses the call (main-host.ts says why in the server's log); the window hears that it failed.
  assert.equal(snooped.ok, false, JSON.stringify(snooped))
  assert.deepEqual(turns, ['hello', 'twice', 'long', 'once'])
})
