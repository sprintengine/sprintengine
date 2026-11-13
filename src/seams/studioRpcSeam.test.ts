import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, test } from 'vitest'

import {
  StudioError,
  type ConversationFollowFrame,
  type ConversationEventStream,
  type StudioClient,
} from '../../packages/client-runtime/src/public'
import { connectToStudio } from '../../packages/agent-sdk/src/node'
import {
  STUDIO_AGENT_SETTINGS_METHODS,
  STUDIO_AGENT_SETUP_METHODS,
  STUDIO_CHAT_STORES_METHODS,
  STUDIO_AGENT_SKILLS_METHODS,
  STUDIO_SCHEDULES_METHODS,
  STUDIO_FILE_SYSTEM_METHODS,
  STUDIO_GIT_METHODS,
  STUDIO_WORKTREES_METHODS,
  STUDIO_CHAT_LIFECYCLE_METHODS,
  STUDIO_CANVAS_METHODS,
  STUDIO_EXTENSIONS_METHODS,
  STUDIO_ARTIFACTS_METHODS,
  STUDIO_CHAT_METHODS,
  STUDIO_FOLLOWED_METHODS,
  STUDIO_METHODS,
  STUDIO_METHOD_ACCESS,
  studioGrantAllows,
  type StudioAgentSettingsMethod,
  type StudioSchedulesMethod,
  type StudioChatLifecycleMethod,
  type StudioCanvasMethod,
  type StudioAgentSetupMethod,
  type StudioChatStoresMethod,
  type StudioAgentSkillsMethod,
  type StudioFileSystemMethod,
  type StudioGitMethod,
  type StudioWorktreesMethod,
  type StudioExtensionsMethodMap,
  type StudioArtifactsMethodMap,
  type StudioChatMethod,
  type StudioMethod,
} from '../../packages/studio-protocol/src/public'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../shared/workspace-registry'
import type { Workspace } from '../renderer/src/types/workspace'
import { createStaticAppIdentity } from '../server/platform/app-identity'
import { createLocalClientBus } from '../server/platform/client-bus'
import { STUDIO_LOCAL_APPS_CHANGED_CHANNEL, type StudioLocalAppsStatus } from '../shared/studio-local-apps'
import { createGatewayAuditStore } from '../main/automation/gateway-audit'
import { createConversationGatewayHost } from '../main/automation/tailnet/tailnet-conversation-host'
import { createConversationLaunchService } from '../main/conversation-launch-service'
import { ConversationRuntime } from '../main/conversation-runtime'
import { createStudioConversationBackend } from '../main/studio-rpc/studio-conversation-backend'
import { createStudioRpcService, type StudioRpcService } from '../main/studio-rpc/studio-rpc-service'
import { createWorkspaceRegistryService } from '../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../main/workspace-sync-service'

// ── Seam: a local app, the SDK, the Studio RPC and a real chat ──────────────
//
// Each side is tested on its own: the protocol's validators, the RPC against a
// fake backend, the SDK against that same RPC. What none of them shows is that
// the client the SDK ships and the server the app ships agree end to end. This
// suite wires the app's own pieces — the conversation runtime with a stand-in
// provider as the only fake, the launch service, the workspace bus, the
// conversation host the tailnet lane wraps, the local app store and the
// gateway's audit — and drives them with the SDK over a real socket:
//
//   SDK connectToStudio ─ owner socket ─ connection ─ router ─ backend
//     ─ conversation host / launch service ─ ConversationRuntime ─ events back

let root: string
let userData: string
let service: StudioRpcService
let runtime: ConversationRuntime
const bus = createLocalClientBus()
const published: Array<{ topic: string; payload: unknown }> = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-rpc-seam-'))
  userData = join(root, 'user-data')
  const folder = join(root, 'project')
  await mkdir(folder, { recursive: true })
  await mkdir(userData, { recursive: true })
  const workspace: Workspace = {
    id: 'ws-a',
    name: 'ws-a',
    mode: 'standard',
    folderPath: folder,
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
  const event = (
    base: { sessionId: string; workspaceId: string; agentId: string; providerId: string; modelId: string },
    type: ConversationEventType,
    payload: Record<string, unknown> = {},
  ): ConversationEvent => ({ id: '', ...base, type, createdAt: 0, payload })
  runtime = new ConversationRuntime({
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
        listModels: () => ['default', 'sonnet'],
        startSession: (input) => [event(input, 'session_started'), event(input, 'session_ready')],
        async *sendTurn(input) {
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
  // As app-services wires them.
  const launch = createConversationLaunchService({
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
  const audit = createGatewayAuditStore({ resolveUserDataDir: () => userData })
  bus.subscribe((topic, payload) => published.push({ topic, payload }))
  service = createStudioRpcService({
    // The platform's pieces, as a standalone server would install them.
    paths: { dataDir: () => userData },
    identity: createStaticAppIdentity({ version: '0.0.0-seam' }),
    clients: bus,
    backend: () =>
      createStudioConversationBackend({
        host: createConversationGatewayHost(
          runtime,
          (workspaceId) => registry.getRecord(workspaceId)?.folderPath ?? null,
          () =>
            registry
              .getRecords()
              .filter((record) => Boolean(record.folderPath))
              .map((record) => ({ workspaceId: record.id, workspaceRoot: record.folderPath! })),
          (key) => registry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset ?? 'auto',
        ),
        launch: (request) => launch.launch(request),
        listSessions: (input) => runtime.listSessions(input),
        stopSession: (input) => runtime.stopSession(input),
        getWorkspaceAgents: () => sync.getSnapshot().state.workspaces,
      }),
    audit: () => audit,
  })
  await service.start()
  assert.equal(service.getStatus().lastError, null)
  assert.equal(service.getStatus().running, true)
})

afterAll(async () => {
  await service.stop()
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
})

async function pairedClient(scopes: string[], ceiling: string): Promise<StudioClient> {
  const { code } = service.offer({ name: 'seam-app', scopes, ceiling })
  return connectToStudio({
    name: 'seam-app',
    pairingCode: code,
    tokenFile: join(root, `token-${Math.random().toString(36).slice(2)}`),
    dataDir: userData,
  })
}

async function until(stream: ConversationEventStream, done: (frame: ConversationFollowFrame) => boolean) {
  const seen: ConversationFollowFrame[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return seen
    seen.push(step.value)
    if (done(step.value)) return seen
  }
}
const texts = (frames: ConversationFollowFrame[]) =>
  frames.flatMap((frame) =>
    frame.type === 'event' && frame.event.type === 'content_delta' ? [String(frame.event.payload?.text)] : [],
  )

test('a paired app starts a chat, follows it and drives it, held to its ceiling', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:operate', 'conversation:create'], 'auto')
  try {
    assert.equal(client.supports('conversation-create'), true)
    const chat = await client.createConversation({
      workspaceId: 'ws-a',
      cli: 'claude-code',
      prompt: 'hello',
      permissionPreset: 'bypass',
      commandId: 'make-chat',
    })
    // Asked for bypass, given the ceiling.
    assert.equal(chat.info.permissionPreset, 'auto')
    const stream = chat.events()
    const opening = await until(stream, (frame) => frame.type === 'event' && frame.event.type === 'turn_completed')
    const snapshot = opening.find((frame) => frame.type === 'snapshot')
    const snapshotTexts =
      snapshot?.type === 'snapshot'
        ? snapshot.page.events.flatMap((event) => (event.type === 'content_delta' ? [String(event.payload?.text)] : []))
        : []
    assert.deepEqual([...snapshotTexts, ...texts(opening)].join(''), 're: hello')
    assert.ok(stream.cursor)

    await chat.send('again')
    const second = await until(stream, (frame) => frame.type === 'event' && frame.event.type === 'turn_completed')
    assert.deepEqual(texts(second), ['re: again'])

    // A retried create finds the chat the first one made; another create
    // under the same id is another command, and is refused.
    const request = {
      workspaceId: 'ws-a',
      cli: 'claude-code',
      prompt: 'hello',
      permissionPreset: 'bypass' as const,
      commandId: 'make-chat',
    }
    const retried = await client.conversations.create(request)
    assert.equal(retried.ok && retried.conversation.agentId, chat.ref.agentId)
    const other = await client.conversations.create({ ...request, prompt: 'something else' })
    assert.equal(!other.ok && other.code, 'command_id_conflict')

    // The listing the app reads is the conversation lane's own thread shape.
    const listed = (await client.conversations.list()).find((thread) => thread.agentId === chat.ref.agentId)
    assert.equal(listed?.permissionPreset, 'auto')

    // No catalog on this machine for the chat's CLI: refused in the lane's own word.
    await assert.rejects(chat.setModel('sonnet'), (error: StudioError) => error.code === 'unsupported_model')
    const lowered = await chat.setPermissions({ preset: 'manual' })
    assert.equal(lowered.permissionPreset, 'manual')
    stream.close()

    // The audit names the app by the identity its token proved, and never a message.
    const auditText = await readFile(join(userData, 'sprintengine-studio-mcp-audit.jsonl'), 'utf8')
    const lines = auditText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; connection: { kind: string; clientName?: string } })
    assert.ok(lines.some((line) => line.tool === 'conversation.create' && line.connection.kind === 'studio-client'))
    assert.ok(lines.some((line) => line.tool === 'conversation.send' && line.connection.clientName === 'seam-app'))
    assert.equal(auditText.includes('again'), false)
  } finally {
    client.close()
  }
})

test('a stop resent after the chat started again does not stop it again', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:operate', 'conversation:create'], 'auto')
  try {
    const chat = await client.createConversation({ workspaceId: 'ws-a', cli: 'claude-code' })
    const live = () => {
      const listed = runtime.listSessions({ workspaceId: 'ws-a', agentId: chat.ref.agentId })
      return listed.ok ? listed.sessions.filter((session) => session.status !== 'stopped') : []
    }
    await chat.stop({ commandId: 'halt' })
    assert.equal(live().length, 0)
    // The chat is sent to again, which starts its session again.
    await chat.send('back again')
    assert.equal(live().length, 1)
    // The same stop, as a client resends it after a reconnect.
    await chat.stop({ commandId: 'halt' })
    assert.equal(live().length, 1)
  } finally {
    client.close()
  }
})

test('revoking the app in Settings ends its stream and its client', async () => {
  const client = await pairedClient(['conversation:read', 'conversation:create'], 'manual')
  const chat = await client.createConversation({ workspaceId: 'ws-a', cli: 'claude-code' })
  const stream = chat.events()
  await until(stream, (frame) => frame.type === 'synchronized')
  const app = service.getStatus().apps.find((entry) => entry.id === client.grant.clientId)
  assert.equal(app?.connected, true)
  published.length = 0
  service.revoke(client.grant.clientId)
  await assert.rejects(stream.next(), (error: StudioError) => error.code === 'revoked')
  // Settings hears it on the platform's client bus, with the app gone.
  const pushed = published.filter((entry) => entry.topic === STUDIO_LOCAL_APPS_CHANGED_CHANNEL).at(-1)
  assert.equal(
    (pushed?.payload as StudioLocalAppsStatus | undefined)?.apps.some((entry) => entry.id === client.grant.clientId),
    false,
  )
  // Parked, not retrying: another try would only be refused again.
  for (let tries = 0; client.state !== 'parked' && tries < 100; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.state, 'parked')
  await assert.rejects(client.request('server.info', {}), (error: StudioError) => error.code === 'revoked')
})

test('every method the server serves has its call in the SDK, under the same scope', async () => {
  // The SDK's ref-level service, call by call, to the method each one sends.
  const sdkCalls: Record<StudioMethod, string> = {
    'server.info': 'request',
    'server.ping': 'request',
    'conversation.list': 'conversations.list',
    'conversation.create': 'conversations.create',
    'conversation.send': 'conversations.send',
    'conversation.interrupt': 'conversations.interrupt',
    'conversation.resolveApproval': 'conversations.respondToApproval',
    'conversation.answerQuestion': 'conversations.answerQuestion',
    'conversation.resolvePlan': 'conversations.resolvePlan',
    'conversation.setPermissionPreset': 'conversations.setPermissionPreset',
    'conversation.setModel': 'conversations.setModel',
    'conversation.stop': 'conversations.stop',
    // Taking back a held message is Studio's own windows', called by name.
    'conversation.cancelQueued': 'request',
    // So is stopping one agent of a chat: no SDK call names it yet.
    'conversation.stopSubagent': 'request',
    'conversation.messageSubagent': 'request',
    // And a chat's effort, its MCP servers and its agent's restart, as a chat
    // followed from another desktop uses them.
    'conversation.setReasoningEffort': 'request',
    'conversation.mcpServerAction': 'request',
    'conversation.restartSession': 'request',
    // And scheduling a message for a time, sending one early or deleting it.
    'conversation.scheduleSend': 'request',
    'conversation.sendScheduledNow': 'request',
    'conversation.cancelScheduled': 'request',
    // And a usage limit's resume, which the tray row asks for.
    'conversation.usageLimitResume': 'request',
    'conversation.loadEarlier': 'conversations.loadEarlier',
    'conversation.toolDetail': 'conversations.toolDetail',
    'conversation.event': 'conversations.event',
    'conversation.turnDiff': 'conversations.turnDiff',
    // What a follower of a chat reads and does beside its stream, as a chat
    // followed from another desktop or the phone uses them, called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_FOLLOWED_METHODS).map((method) => [method, 'request'])) as Record<
      keyof typeof STUDIO_FOLLOWED_METHODS,
      string
    >),
    // The chat surface is Studio's own windows' and is called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_CHAT_METHODS).map((method) => [method, 'request'])) as Record<
      StudioChatMethod,
      string
    >),
    // Client tools: a withdrawal is the offered toolset's own `withdraw`, and
    // opening a chat to an app is Studio's own windows' and called by name.
    'tools.offer': 'tools.offer',
    'tools.withdraw': 'tools.offer',
    'tools.focus': 'tools.focus',
    'tools.catalog': 'tools.catalog',
    'tools.grant': 'request',
    'tools.grants': 'request',
    // Files by root are Studio's own clients' (the canvas over a server's boards), called by name.
    'files.roots': 'request',
    'files.list': 'request',
    'files.read': 'request',
    'files.write': 'request',
    'files.remove': 'request',
    // A Studio's pull requests are its own clients' marks, called by name.
    'pullRequests.list': 'request',
    'pullRequests.refresh': 'request',
    'pullRequests.noteWork': 'request',
    'pullRequests.noteToolCall': 'request',
    'pullRequests.link': 'request',
    'pullRequests.unwatch': 'request',
    'pullRequests.createState': 'request',
    'pullRequests.draft': 'request',
    'pullRequests.draftCancel': 'request',
    'pullRequests.push': 'request',
    'pullRequests.create': 'request',
    // So are its local servers.
    'localServers.list': 'request',
    'localServers.run': 'request',
    'localServers.stop': 'request',
    'localServers.remove': 'request',
    // A module's declared methods, called by name: a window's renderer halves.
    'module.read': 'request',
    'module.operate': 'request',
    // What runs on the Studio: listed, and changed from Settings, by name.
    'module.list': 'request',
    'module.setEnabled': 'request',
    'module.install': 'request',
    'module.setTrust': 'request',
    'module.uninstall': 'request',
    // The extensions installed there, their window halves, and what a window sets for them.
    'module.installed': 'request',
    'module.rendererEntries': 'request',
    'module.setAppState': 'request',
    'module.reportRegistry': 'request',
    // The host's services a renderer half calls, by name too.
    'moduleBacklog.location': 'request',
    'moduleBacklog.create': 'request',
    'moduleBacklog.updateStatus': 'request',
    'moduleBacklog.updateTriage': 'request',
    'moduleBacklog.addLink': 'request',
    'moduleBacklog.updateModuleMetadata': 'request',
    'moduleUsage.query': 'request',
    // And what a client reads before it starts a chat.
    'workspaces.list': 'request',
    'cliRuntimes.list': 'request',
    'workspaces.checkout': 'request',
    'workspaces.extensions': 'request',
    'terminal.list': 'request',
    'terminal.status': 'request',
    'terminal.open': 'request',
    'terminal.resume': 'request',
    'terminal.write': 'request',
    'terminal.ack': 'request',
    'terminal.resize': 'request',
    'terminal.setVisible': 'request',
    'terminal.suspend': 'request',
    'terminal.close': 'request',
    'terminal.setReapExempt': 'request',
    'terminal.takeUndeliveredPrompts': 'request',
    'terminal.configure': 'request',
    // Updates are asked like any method on a normal connection, and through
    // `openStudioUpdateSession` on one kept for them.
    'update.status': 'request',
    'update.start': 'request',
    // A Studio's CLIs and launch settings are its own clients' (Settings), called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_AGENT_SETTINGS_METHODS).map((method) => [method, 'request'])) as Record<
      StudioAgentSettingsMethod,
      string
    >),
    // So is what its agents are set up with.
    ...(Object.fromEntries(Object.keys(STUDIO_AGENT_SETUP_METHODS).map((method) => [method, 'request'])) as Record<
      StudioAgentSetupMethod,
      string
    >),
    // What the machine lacks for its schedules and watches, asked like any read.
    'environment.readiness': 'request',
    'environment.windowTicket': 'request',
    'providers.signInStart': 'request',
    'providers.signInPaste': 'request',
    'providers.signInWait': 'request',
    'providers.signInCancel': 'request',
    // What a Studio keeps beside its chats, which its own windows draw (the
    // trays, Settings, the usage dashboard, onboarding), called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_CHAT_STORES_METHODS).map((method) => [method, 'request'])) as Record<
      StudioChatStoresMethod,
      string
    >),
    // The phone's reads beside its chats (`backlog.ts`, `pull-request-reads.ts`), called by name.
    'backlog.list': 'request',
    'backlog.update': 'request',
    // A project's backlog by its folder, which the desktop's own Backlog panel drives, called by name.
    'backlog.location': 'request',
    'backlog.setRoot': 'request',
    'backlog.ensureRecords': 'request',
    'backlog.ensureIds': 'request',
    'backlog.edit': 'request',
    'backlog.createEpic': 'request',
    'shares.list': 'request',
    'pullRequests.detail': 'request',
    'pullRequests.diff': 'request',
    // And the skills, design systems and cards they are given.
    ...(Object.fromEntries(Object.keys(STUDIO_AGENT_SKILLS_METHODS).map((method) => [method, 'request'])) as Record<
      StudioAgentSkillsMethod,
      string
    >),
    // A Studio's scheduled agents, which the phone and a paired desktop
    // drive (`schedules.ts`), called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_SCHEDULES_METHODS).map((method) => [method, 'request'])) as Record<
      StudioSchedulesMethod,
      string
    >),
    // The files on a Studio's machine by path, which its own windows browse and edit, called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_FILE_SYSTEM_METHODS).map((method) => [method, 'request'])) as Record<
      StudioFileSystemMethod,
      string
    >),
    // And git on it, which its windows' Git pane and diff view drive, called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_GIT_METHODS).map((method) => [method, 'request'])) as Record<
      StudioGitMethod,
      string
    >),
    // And the worktrees its agents run in, with settled chats, which its
    // windows' Settings ▸ Worktrees and Delete drive, called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_WORKTREES_METHODS).map((method) => [method, 'request'])) as Record<
      StudioWorktreesMethod,
      string
    >),
    // A chat's record beyond its rest, which the phone and a paired desktop
    // write (`chat-lifecycle.ts`), called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_CHAT_LIFECYCLE_METHODS).map((method) => [method, 'request'])) as Record<
      StudioChatLifecycleMethod,
      string
    >),
    // A machine's boards, which the phone and a paired desktop read and draw
    // on (`canvas.ts`), called by name.
    ...(Object.fromEntries(Object.keys(STUDIO_CANVAS_METHODS).map((method) => [method, 'request'])) as Record<
      StudioCanvasMethod,
      string
    >),
    // And what it is extended with, which its Extensions door, Settings and New chat use, by name.
    ...(Object.fromEntries(Object.keys(STUDIO_EXTENSIONS_METHODS).map((method) => [method, 'request'])) as Record<
      keyof StudioExtensionsMethodMap,
      string
    >),
    // And where it publishes its agents' pages, which its Settings ▸ Artifacts uses, by name.
    ...(Object.fromEntries(Object.keys(STUDIO_ARTIFACTS_METHODS).map((method) => [method, 'request'])) as Record<
      keyof StudioArtifactsMethodMap,
      string
    >),
  }
  assert.deepEqual(Object.keys(sdkCalls).sort(), Object.keys(STUDIO_METHODS).sort())
  const client = await pairedClient(['conversation:read'], 'manual')
  try {
    for (const call of Object.values(sdkCalls)) {
      const [owner, name] = call.includes('.') ? call.split('.') : [null, call]
      const target = (owner ? (client as never)[owner] : client) as Record<string, unknown>
      assert.equal(typeof target[name!], 'function', call)
    }
    // A read-only app is refused every mutation by the server, in the shape the SDK reads.
    const ref = { workspaceId: 'ws-a', agentId: 'nobody' }
    const service = client.conversations
    const refusals: Record<string, () => Promise<{ ok: boolean; code?: string }>> = {
      'conversation.send': () => service.send(ref, { message: 'x' }),
      'conversation.interrupt': () => service.interrupt(ref),
      'conversation.resolveApproval': () => service.respondToApproval(ref, { requestId: 'r', decision: 'deny' }),
      'conversation.answerQuestion': () => service.answerQuestion(ref, { requestId: 'r', answers: {} }),
      'conversation.resolvePlan': () => service.resolvePlan(ref, { requestId: 'r', decision: 'reject' }),
      'conversation.setPermissionPreset': () => service.setPermissionPreset(ref, 'auto'),
      'conversation.setModel': () => service.setModel(ref, 'm'),
      'conversation.stop': () => service.stop(ref),
      'conversation.create': () => service.create({ workspaceId: 'ws-a' }),
      'update.start': () =>
        client.request('update.start', { commandId: 'update-1' }).then(
          () => ({ ok: true }),
          (error: StudioError) => ({ ok: false, code: error.code }),
        ),
      // A terminal's start and end are an owner's: no app's grant reaches them.
      ...Object.fromEntries(
        (['terminal.open', 'terminal.resume'] as const).map((method) => [
          method,
          () =>
            client.request(method, { sessionId: 't', cols: 80, rows: 24, commandId: `${method}-1` }).then(
              () => ({ ok: true }),
              (error: StudioError) => ({ ok: false, code: error.code }),
            ),
        ]),
      ),
      'terminal.close': () =>
        client.request('terminal.close', { sessionId: 't', commandId: 'close-1' }).then(
          () => ({ ok: true }),
          (error: StudioError) => ({ ok: false, code: error.code }),
        ),
    }
    // Every other mutation is refused it by name, before its params are read.
    const byName = (method: StudioMethod) => () =>
      client.request(method, {} as never).then(
        () => ({ ok: true }),
        (error: StudioError) => ({ ok: false, code: error.code }),
      )
    const mutations = Object.entries(STUDIO_METHODS).filter(([, spec]) => spec.mutation && !spec.owner)
    for (const [method] of mutations) {
      const answer = await (refusals[method] ?? byName(method as StudioMethod))()
      assert.deepEqual([method, answer.ok, answer.code], [method, false, 'scope_required'])
    }
    // The chat surface reaches an app by its scopes, as the protocol's table
    // says: an owner's method is refused as one, one that needs more than
    // reading as a scope, and a read is not refused for its grant at all.
    for (const method of Object.keys(STUDIO_CHAT_METHODS) as StudioChatMethod[]) {
      const refused = await client.request(method, {} as never).then(
        () => null,
        (error: { code?: string }) => error.code,
      )
      const access = STUDIO_METHOD_ACCESS[method]
      const expected =
        'permissions' in access && access.owner !== undefined
          ? 'owner_required'
          : studioGrantAllows(client.grant, method)
            ? 'not refused for its grant'
            : 'scope_required'
      const got = refused === 'owner_required' || refused === 'scope_required' ? refused : 'not refused for its grant'
      assert.deepEqual([method, got], [method, expected])
    }
    const info = await client.request('server.info', {})
    assert.equal(info.grant.clientId, client.grant.clientId)
  } finally {
    client.close()
  }
})
