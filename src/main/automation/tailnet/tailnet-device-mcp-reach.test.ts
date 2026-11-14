import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { authorizeStudioAccess } from '../../../../packages/studio-protocol/src/permissions'
import { launchWhereItLives } from '../../../server/core/environment-chat-calls'
import { createLocalServerTools } from '../../../server/local-servers/local-server-tools'
import { createPullRequestTools } from '../../../server/pull-requests/pull-request-tools'
import type { EnvironmentClients } from '../../../shared/environment-clients'
import type { McpToolRegistration } from '../../../shared/modules/mcp-tools'
import { TAILNET_SCOPES, tailnetDevicePrincipal, type TailnetScope } from '../../../shared/tailnet'
import type { WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import { createArtifactsTools } from '../../artifacts/artifacts-tools'
import type { ConversationLaunchRequest } from '../../conversation-launch-service'
import { createWorktreePoolTools } from '../../worktree-pool/worktree-pool-tools'
import { createAutomationTools, type AutomationBackends } from '../automation-tools'
import { createBrowserTools } from '../browser-tools'
import { createCanvasTools } from '../canvas-tools'
import { createConversationChatTools } from '../conversation-chat-tools'
import { createConversationPullRequestTools } from '../conversation-pull-request-tools'
import { createConversationTools } from '../conversation-tools'
import { createEditorTools } from '../editor-tools'
import { createExtensionTools } from '../extension-tools'
import { createPluginTools } from '../plugin-tools'
import { isStudioGatewayMutation } from '../studio-gateway-tools'
import { createSubagentTools } from '../subagent-tools'
import { createTourTools } from '../tour-tools'
import { createVisualTools } from '../visual-tools'
import { createTailnetDeviceStore } from './tailnet-devices'
import {
  createTailnetGatewayServer,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import { tailnetToolAccess } from './tailnet-scopes'
import { createTailnetTools } from './tailnet-tools'

// Everything a paired device (the phone, another desktop, an agent elsewhere
// holding a device token) reaches on `/tailnet/v1/mcp` and `/tailnet/v1/stream`,
// tool by tool, as tailnet-device-reach.test.ts pins `/tailnet/v1/studio`
// method by method. Every tool the gateway's built-in families register is in
// the table below, so a new one fails here until someone decides whether a
// device reaches it, and a widening is a change to this file someone reviews.
//
// Beside the scope each tool needs, a device is held to this machine's own
// workspaces and folders, as the Studio protocol holds it: never a copy of a
// chat an SSH machine or a WSL distribution holds (a call on one goes out on
// this desktop's own connection to that machine), never a folder outside the
// projects this machine has open. The second half drives the real listener.

const LOCAL = 'local-only' as const
const READ = ['workspace:read', 'workspace:operate'] as const
const OPERATE = ['workspace:operate'] as const
const CHAT_READ = ['conversation:read', 'conversation:operate'] as const
const CHAT_OPERATE = ['conversation:operate'] as const
const BACKLOG_READ = ['backlog:read', 'backlog:operate'] as const
const BACKLOG_OPERATE = ['backlog:operate'] as const

const DEVICE_TOOLS: Readonly<Record<string, typeof LOCAL | readonly TailnetScope[]>> = {
  // This machine's workspaces and CLIs. A device sees only this machine's own
  // workspaces (never a copy of another environment's chat), and creates one
  // only on a folder inside a project already open here.
  'workspace.list': READ,
  'workspace.status': READ,
  'workspace.checkout': READ,
  'workspace.extensions': READ,
  'workspace.create': OPERATE,
  'agent.status': READ,
  'cli.runtime.list': READ,
  'module.list': READ,
  'module.status': READ,
  'marketplace.list': READ,
  'artifacts.list': READ,
  'artifacts.search': READ,
  'artifacts.get': READ,

  // The projects' backlogs, on the pairing's own backlog scopes; a
  // `projectRoot` only inside a project open here.
  'backlog.list': BACKLOG_READ,
  'backlog.read': BACKLOG_READ,
  'backlog.update': BACKLOG_OPERATE,
  'backlog.repair': BACKLOG_OPERATE,
  'backlog.assign': BACKLOG_OPERATE,

  // Starting a chat, on this machine only: a workspace another environment
  // holds is refused before any connection to it is chosen. Moving one, only
  // into a project open here.
  'conversation.create': CHAT_OPERATE,
  'conversation.change_project': CHAT_OPERATE,
  // A chat's Create PR, bound to this machine's own record of the chat.
  'conversation.pull_request_state': CHAT_READ,
  'conversation.pull_request_draft': CHAT_OPERATE,
  'conversation.pull_request_draft_cancel': CHAT_OPERATE,
  'conversation.pull_request_push': CHAT_OPERATE,
  'conversation.pull_request_create': CHAT_OPERATE,

  // The person's screen here: the in-app browser pane, the editor and tours.
  // Reached on the workspace scopes since before the one-protocol work; the
  // read-only browser rows reading the pane's signed-in pages are a known
  // exposure, recorded for the next batch rather than widened or narrowed here.
  'editor.state': READ,
  'editor.open': OPERATE,
  'editor.open_diff': OPERATE,
  'tour.status': READ,
  'tour.create': OPERATE,
  'tour.update': OPERATE,
  'tour.goto': OPERATE,
  'tour.close': OPERATE,
  'browser.status': READ,
  'browser.snapshot': READ,
  'browser.screenshot': READ,
  'browser.wait_for': READ,
  'browser.console': READ,
  'browser.actions': READ,
  'browser.network': READ,
  'browser.open': OPERATE,
  'browser.navigate': OPERATE,
  'browser.click': OPERATE,
  'browser.hover': OPERATE,
  'browser.type': OPERATE,
  'browser.press': OPERATE,
  'browser.scroll': OPERATE,
  'browser.evaluate': OPERATE,
  'browser.resize': OPERATE,
  'browser.set_appearance': OPERATE,
  'browser.dialog': OPERATE,
  'browser.record_start': OPERATE,
  'browser.record_stop': OPERATE,

  // Never to a device, whatever it holds (tailnet-scopes.ts says why for each).
  'agent.launch': LOCAL,
  'backlog.work': LOCAL,
  'terminal.list': LOCAL,
  'terminal.read': LOCAL,
  'terminal.create': LOCAL,
  'schedule.list': LOCAL,
  'schedule.create': LOCAL,
  'schedule.update': LOCAL,
  'schedule.delete': LOCAL,
  'schedule.run': LOCAL,
  'schedule.pause': LOCAL,
  'schedule.resume': LOCAL,
  'canvas.list': LOCAL,
  'canvas.open': LOCAL,
  'canvas.describe': LOCAL,
  'canvas.find': LOCAL,
  'canvas.edit': LOCAL,
  'canvas.layout': LOCAL,
  'canvas.import': LOCAL,
  'canvas.screenshot': LOCAL,
  'visual.preview': LOCAL,
  'conversation.settle': LOCAL,
  'conversation.visit': LOCAL,
  'conversation.mark_unread': LOCAL,
  'conversation.snooze': LOCAL,
  'conversation.highlight': LOCAL,
  'conversation.auto_settle': LOCAL,
  // One chat driving another, which reaches a chat another environment holds
  // through this desktop's own connection to it: never a device's.
  'conversation.send': LOCAL,
  'conversation.read': LOCAL,
  'conversation.wait': LOCAL,
  'conversation.interrupt': LOCAL,
  'subagent.start': LOCAL,
  'subagent.status': LOCAL,
  'subagent.cancel': LOCAL,
  'extension.create': LOCAL,
  'extension.guide': LOCAL,
  'plugin.search': LOCAL,
  'plugin.offer': LOCAL,
  'artifacts.setup': LOCAL,
  'artifacts.publish': LOCAL,
  'artifacts.update': LOCAL,
  'artifacts.delete': LOCAL,
  'worktree.lease': LOCAL,
  'worktree.release': LOCAL,
  'pull_request.link': LOCAL,
  'pull_request.watch': LOCAL,
  'pull_request.unwatch': LOCAL,
  'local_server.link': LOCAL,
  'tailnet.status': LOCAL,
  'tailnet.set_enabled': LOCAL,
  'tailnet.offer_pairing': LOCAL,
  'tailnet.cancel_pairing': LOCAL,
  'tailnet.revoke_device': LOCAL,
  'tailnet.approve_pair_request': LOCAL,
  'tailnet.deny_pair_request': LOCAL,
  'tailnet.list_peers': LOCAL,
}

/** Every tool the gateway's built-in families register, named as each factory names them. */
function builtInTools(): McpToolRegistration[] {
  // The names and mutation flags are fixed when a factory runs; nothing here is called.
  const unused = new Proxy({}, { get: () => () => undefined }) as never
  const factories: Array<(deps: never) => McpToolRegistration[]> = [
    createAutomationTools,
    createEditorTools,
    createBrowserTools,
    createVisualTools,
    createCanvasTools,
    createTourTools,
    createConversationTools,
    createConversationChatTools,
    createConversationPullRequestTools,
    createSubagentTools,
    createExtensionTools,
    createPluginTools,
    createArtifactsTools,
    createWorktreePoolTools,
    createPullRequestTools,
    createLocalServerTools,
    createTailnetTools,
  ]
  return factories.flatMap((factory) => factory(unused))
}

/** The device scopes that, each on its own, reach a tool; local-only when no grant does. */
function reachOfTool(name: string, tools: McpToolRegistration[]): typeof LOCAL | TailnetScope[] {
  const access = tailnetToolAccess(
    name,
    isStudioGatewayMutation(name, () => tools),
  )
  if ('localOnly' in access && access.localOnly) return LOCAL
  return TAILNET_SCOPES.filter((scope) => authorizeStudioAccess(tailnetDevicePrincipal([scope]), access).ok)
}

test('every built-in tool has a device decision, and the table names no other', () => {
  const tools = builtInTools()
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, Object.keys(DEVICE_TOOLS).sort())
})

test('each tool is reached by exactly the scopes its row names, and a local-only one by none', () => {
  const tools = builtInTools()
  for (const [name, expected] of Object.entries(DEVICE_TOOLS))
    assert.deepEqual(reachOfTool(name, tools), expected === LOCAL ? LOCAL : [...expected], name)
})

// ── The listener itself, over /mcp and /stream ──────────────────────────────

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tailnet-mcp-reach-')))
  dirs.push(dir)
  return dir
}

type Answer = { ok: boolean; code: string | null; value: Record<string, unknown> }

function answerOf(body: unknown): Answer {
  const result = (body as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } }).result
  const content = result?.structuredContent ?? {}
  const error = (content as { error?: { code?: string } }).error
  return { ok: result?.isError !== true, code: error?.code ?? null, value: content }
}

async function startListener() {
  const root = scratch()
  const project = join(root, 'acme-app')
  const outside = join(root, 'elsewhere')
  mkdirSync(project)
  mkdirSync(outside)
  const workspaces = [
    { id: 'w-here', name: 'acme-app', mode: 'agents', folderPath: project, agents: {} },
    {
      id: 'w-ssh',
      name: 'repo',
      mode: 'agents',
      folderPath: 'ssh://build-box/home/dev/repo',
      environment: { kind: 'ssh', id: 'build-box', label: 'build-box' },
      agents: {},
    },
    {
      id: 'w-wsl',
      name: 'distro-app',
      mode: 'agents',
      folderPath: '/home/dev/distro-app',
      hostId: 'wsl:Ubuntu',
      environment: { kind: 'wsl', id: 'Ubuntu', label: 'Ubuntu' },
      agents: {},
    },
  ]
  const snapshot = {
    state: { workspaces, workspaceWindows: [], activeWorkspaceId: null, primaryWorkspaceWindowId: null },
  } as unknown as WorkspaceSyncSnapshot
  const recordOf = (id: string) => workspaces.find((workspace) => workspace.id === id) as never
  const reached: string[] = []
  const clients: EnvironmentClients = {
    clientFor: async (route) => {
      reached.push(route)
      return { ok: false, code: 'unavailable', message: 'not in this test' }
    },
    onConnected: () => () => undefined,
  }
  const launchedHere: ConversationLaunchRequest[] = []
  const created: Array<string | undefined> = []
  const backlogRoots: string[] = []
  const moved: string[] = []
  const backends = new Proxy(
    {
      getWorkspaceSyncSnapshot: () => snapshot,
      listTerminalSessions: () => [],
      readRepositoryIdentity: async () => null,
      resolveAgentPermissionPreset: () => null,
      createWorkspace: (input: { folderPath?: string }) => {
        created.push(input.folderPath)
        return {
          ok: true,
          result: { workspace: { id: 'w-new', name: 'new', mode: 'agents', folderPath: input.folderPath, agents: {} } },
        }
      },
      listBacklogItems: async (workspaceRoot: string) => {
        backlogRoots.push(workspaceRoot)
        return { ok: true, items: [] }
      },
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : undefined) },
  ) as unknown as AutomationBackends
  const tools: McpToolRegistration[] = [
    ...createAutomationTools(backends),
    ...createConversationTools({
      launch: launchWhereItLives(clients, recordOf, async (request) => {
        launchedHere.push(request)
        return { ok: false, code: 'launched_here', message: 'launched on this machine' }
      }),
      resolveAgentPermissionPreset: () => null,
      lifecycle: {} as never,
      moveChat: async (workspaceId, folder) => {
        moved.push(folder)
        return { ok: true, workspaceId, folderPath: folder, project: folder }
      },
      deviceMayName: async (folder) => folder === project || folder.startsWith(`${project}/`),
    }),
  ]
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => root })
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => tools,
    isMutation: (name) => isStudioGatewayMutation(name, () => tools),
    devices,
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  const port = server.address()!.port

  function post(path: string, token: string | null, body: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body)
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null })
          })
        },
      )
      request.on('error', reject)
      request.end(payload)
    })
  }

  const offer = devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
  const paired = await post(TAILNET_PAIR_PATH, null, { pairingToken: offer.token, deviceName: 'android-phone' })
  assert.equal(paired.status, 200)
  const token = (paired.body as { deviceToken: string }).deviceToken
  let nextId = 0

  /** One tool call over `/tailnet/v1/mcp`, as a device. */
  async function overMcp(name: string, args: Record<string, unknown>): Promise<Answer> {
    const answer = await post(TAILNET_MCP_PATH, token, {
      jsonrpc: '2.0',
      id: ++nextId,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    assert.equal(answer.status, 200)
    return answerOf(answer.body)
  }

  /** One tool call over `/tailnet/v1/stream`, as a device, on a socket of its own. */
  async function overStream(name: string, args: Record<string, unknown>): Promise<Answer> {
    const ticketed = await post(TAILNET_WS_TICKET_PATH, token, {})
    assert.equal(ticketed.status, 200)
    const ticket = (ticketed.body as { ticket: string }).ticket
    const socket = new WebSocket(`ws://127.0.0.1:${port}${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(ticket)}`)
    const id = ++nextId
    try {
      return await new Promise<Answer>((resolve, reject) => {
        socket.addEventListener('error', () => reject(new Error('the stream failed')))
        socket.addEventListener('open', () =>
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })),
        )
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as { id?: unknown }
          if (message.id === id) resolve(answerOf(message))
        })
      })
    } finally {
      socket.close()
    }
  }

  return {
    project,
    outside,
    reached,
    launchedHere,
    created,
    backlogRoots,
    moved,
    overMcp,
    overStream,
    close: () => server.stop(),
  }
}

test("a device cannot start a chat on an SSH machine or in a WSL distribution, over /mcp or /stream; this machine's own still start", async () => {
  const listener = await startListener()
  try {
    for (const call of [listener.overMcp, listener.overStream]) {
      for (const workspaceId of ['w-ssh', 'w-wsl']) {
        const refused = await call('conversation.create', { workspaceId, prompt: 'Go', permissionPreset: 'bypass' })
        assert.equal(refused.ok, false, workspaceId)
        assert.equal(refused.code, 'tailnet_local_only', workspaceId)
      }
    }
    // Refused before any connection to that machine was chosen.
    assert.deepEqual(listener.reached, [])
    assert.equal(listener.launchedHere.length, 0)
    const here = await listener.overMcp('conversation.create', { workspaceId: 'w-here', prompt: 'Go' })
    assert.equal(here.code, 'launched_here')
    assert.deepEqual(
      listener.launchedHere.map((request) => request.workspaceId),
      ['w-here'],
    )
  } finally {
    await listener.close()
  }
})

test("a device lists and reads only this machine's own workspaces, never the copies of another environment's chats", async () => {
  const listener = await startListener()
  try {
    for (const call of [listener.overMcp, listener.overStream]) {
      const listed = await call('workspace.list', {})
      assert.ok(listed.ok)
      assert.deepEqual(
        (listed.value.workspaces as Array<{ id: string }>).map((workspace) => workspace.id),
        ['w-here'],
      )
      for (const workspaceId of ['w-ssh', 'w-wsl']) {
        assert.equal((await call('workspace.status', { workspaceId })).code, 'unknown_workspace', workspaceId)
        assert.equal((await call('workspace.checkout', { workspaceId })).code, 'unknown_workspace', workspaceId)
        assert.equal(
          (await call('agent.status', { workspaceId, agentId: 'a1' })).code,
          'unknown_workspace',
          workspaceId,
        )
      }
    }
  } finally {
    await listener.close()
  }
})

test('a device names only folders inside the projects this machine has open', async () => {
  const listener = await startListener()
  try {
    for (const call of [listener.overMcp, listener.overStream]) {
      assert.equal(
        (await call('workspace.create', { folderPath: listener.outside })).code,
        'folder_refused',
        'a new workspace on any folder',
      )
      assert.equal(
        (await call('conversation.change_project', { workspaceId: 'w-here', folder: listener.outside })).code,
        'folder_refused',
        'a chat moved to any folder',
      )
      assert.equal(
        (await call('backlog.list', { projectRoot: listener.outside })).code,
        'folder_refused',
        'a backlog read in any folder',
      )
    }
    assert.deepEqual(listener.created, [])
    assert.deepEqual(listener.moved, [])
    assert.deepEqual(listener.backlogRoots, [])

    const inside = join(listener.project, 'packages')
    mkdirSync(inside)
    assert.ok((await listener.overMcp('workspace.create', { folderPath: inside })).ok)
    assert.ok((await listener.overMcp('conversation.change_project', { workspaceId: 'w-here', folder: inside })).ok)
    assert.ok((await listener.overMcp('backlog.list', { projectRoot: listener.project })).ok)
    assert.deepEqual(listener.created, [inside])
    assert.deepEqual(listener.moved, [inside])
    assert.deepEqual(listener.backlogRoots, [listener.project])
  } finally {
    await listener.close()
  }
})
