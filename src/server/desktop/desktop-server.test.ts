import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, test } from 'vitest'

import {
  connect as connectStudio,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../packages/client-runtime/src/public'
import type { StudioWindowTicket } from '../../shared/studio-connection'
import { createControlRpc } from '../bootstrap/control-rpc'
import { createMessageHub, type ServerControlChannel } from '../bootstrap/control-channel'
import type { ServerBootstrapEnvelope } from '../bootstrap/envelope'
import { serveOnChannel } from '../bootstrap/serve'
import { applyGatewayLaunchTokenChange, resolveGatewayLaunchToken } from '../core/gateway-launch-tokens'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { resetStudioPlatform } from '../platform/platform'
import { serveShellBridge } from '../shell-bridge/serve-shell-bridge'
import type { ShellBridge } from '../shell-bridge/shell-bridge'
import { startDesktopServer } from './desktop-server'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS, type ServerMirrorState } from './server-methods'

// The desktop's server out of process, composed for real over a temp data
// directory and driven the way the shell drives it: an envelope on the control
// channel, the shell bridge served back, a window's port carrying tunnelled
// IPC, the mirror the shell reads, and a drain at the end. No Electron: the
// carrier is a fake parent port, and the shell is this test.

const ROOT = join(__dirname, '..', '..', '..')
let scratch = ''
let previousHome: string | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-desktop-server-'))
  previousHome = process.env.HOME
  // Module discovery and the launcher pointer are read from the home folder.
  process.env.HOME = join(scratch, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
})
/** The window clients a test opened, closed with the server's scratch. */
const windows: StudioClient[] = []

afterAll(() => {
  for (const client of windows.splice(0)) client.close()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  resetStudioPlatform()
  rmSync(scratch, { recursive: true, force: true })
})

const keychainSeal = (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').reverse()])

function shellBridge(): ShellBridge & { notices: unknown[]; prepared: string[] } {
  const notices: unknown[] = []
  const prepared: string[] = []
  return {
    notices,
    prepared,
    cipher: {
      available: async () => true,
      seal: async (plain) => new Uint8Array(keychainSeal(Buffer.from(plain).toString('utf8'))),
      open: async (sealed) => new Uint8Array(Buffer.from(Buffer.from(sealed).subarray(3)).reverse()),
    },
    // The shell's part of a launch; the pty itself is the server's.
    launches: {
      prepareLaunchIntegration: async (input) => {
        prepared.push(`integration:${input.cli}`)
        return { ok: true, integration: null }
      },
      syncMcpConfig: async () => ({ ok: true }),
      ensureBuiltinSkillInstalled: async () => undefined,
      excludeWorktreeMcpConfig: async () => undefined,
      prepareAgentStateHook: async () => undefined,
    },
    reveal: { tab: async () => false },
    notify: (notice) => notices.push(notice),
    analytics: () => undefined,
    integrationsReady: async () => undefined,
    images: { downscale: async (bytes, mediaType) => ({ bytes, mediaType }) },
  }
}

/** The window's end of a port pair the test holds; the server holds the other. */
function windowPort() {
  const server = { message: [] as Array<(event: { data: unknown }) => void>, close: [] as Array<() => void> }
  const received: Array<Record<string, any>> = []
  const port: TunnelPort = {
    postMessage: (message) => received.push(structuredClone(message) as Record<string, any>),
    on: (event: 'message' | 'close', listener: any) => {
      server[event].push(listener)
      return port
    },
    start: () => undefined,
    close: () => undefined,
  }
  let nextId = 1
  return {
    port,
    received,
    async invoke(channel: string, ...args: unknown[]): Promise<Record<string, any>> {
      const id = nextId++
      for (const listener of server.message) listener({ data: { t: 'ipc.invoke', id, channel, args } })
      for (let tries = 0; tries < 2_000; tries++) {
        const found = received.find((frame) => frame.t === 'ipc.result' && frame.id === id)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`no answer on ${channel}`)
    },
  }
}

test('the desktop server composes, serves a window over the tunnel and the shell over the control channel, and drains', async () => {
  const dataDir = join(scratch, 'profile')
  const hub = createMessageHub()
  const fromServer: Array<Record<string, any>> = []
  const shellRpc = createControlRpc((frame) => setImmediate(() => hub.dispatch(frame, [])))
  const channel: ServerControlChannel = {
    carriesPorts: true,
    send(frame) {
      const recorded = frame as Record<string, any>
      fromServer.push(recorded)
      setImmediate(() => shellRpc.receive(recorded))
    },
    onMessage: (listener) => hub.add(listener),
    onClose: () => () => undefined,
  }
  const bridge = shellBridge()
  serveShellBridge(shellRpc, bridge)
  // A terminal agent the shell launched before this server started holds this token.
  const terminalAgent = { workspaceId: 'acme', agentId: 'agent-1' }
  const tokenDigest = createHash('sha256').update('terminal-agent-token').digest('hex')
  shellRpc.handle(SHELL_METHODS.liveLaunchTokens, () => [{ digest: tokenDigest, identity: terminalAgent }])
  // The server's terminals, as the shell's own readers see them.
  const terminalLists: unknown[] = []
  shellRpc.on(SERVER_EVENTS.terminalSessions, (payload) => terminalLists.push(payload))

  const exit = serveOnChannel(channel, {
    starters: { 'desktop-local': startDesktopServer },
    unwrapEnvelope: true,
    buildStamp: null,
    log: () => undefined,
  })
  const envelope: ServerBootstrapEnvelope = {
    v: 1,
    role: 'desktop-local',
    dataDir,
    logsDir: join(dataDir, 'logs'),
    runDir: join(dataDir, 'run'),
    tempDir: tmpdir(),
    paths: { resourcesDir: null, appPath: ROOT, isPackaged: false, appExecPath: process.execPath },
    app: { version: '0.0.0-test', buildStamp: '', channel: 'nightly' },
    owner: {},
    listeners: { gateway: true, tailnet: 'from-settings' },
    secrets: { kind: 'shell', available: true },
    flags: {},
  }
  hub.dispatch({ t: 'envelope', envelope }, [])
  const ready = await waitFor(() => fromServer.find((frame) => frame.t === 'ready' || frame.t === 'fatal'))
  assert.equal(ready.t, 'ready', JSON.stringify(ready))
  assert.equal(typeof ready.gateway.socketPath, 'string')
  // Its bridge is proven the moment the socket is back, before any push after ready.
  assert.deepEqual(resolveGatewayLaunchToken('terminal-agent-token'), terminalAgent)
  applyGatewayLaunchTokenChange({ digest: tokenDigest, identity: null })
  // Desktop role: the lock names the desktop, so the app's own server is never refused by its parent.
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'run', 'studio.lock'), 'utf8')).role, 'desktop')

  // A window attaches. Nothing it asks is tunnelled to the server's domains
  // any more: its registry and this computer's machines are the Studio
  // protocol's, on a ticket the shell buys for the window, then the window's
  // own connection to the listener.
  const window = windowPort()
  hub.dispatch(
    { t: 'attach-client', clientId: 'window-1-1', windowId: 'primary', kind: 'desktop-window', workspaceWindow: true },
    [window.port],
  )
  const studio = await windowStudio(shellRpc)
  const snapshot = await studio.request('workspaceSync.snapshot', {})
  assert.ok(Array.isArray(snapshot.state.workspaces))
  const hosts = await studio.request('hosts.list', {})
  assert.equal(hosts.hosts[0]?.id, 'local', JSON.stringify(hosts))

  // The terminals are this server's: their list reaches the shell once it is
  // serving, and a launch the shell asks for goes through the server's own
  // launch service (no refusal, no bridge back to the shell).
  await waitFor(() => (terminalLists.length > 0 ? true : undefined))
  assert.deepEqual(terminalLists[0], [])
  const launched = await shellRpc.call<{ ok: boolean; code?: string; message?: string }>(SERVER_METHODS.agentLaunch, {
    workspaceId: 'no-such-workspace',
    cli: 'claude-code',
  })
  assert.equal(launched.ok, false)
  assert.equal(launched.code, 'unknown_workspace', JSON.stringify(launched))
  assert.equal(await shellRpc.call(SERVER_METHODS.terminalPeekState, { sessionId: 'none' }), null)

  // The shell's mirror reads from the server.
  const mirror = await shellRpc.call<ServerMirrorState>(SERVER_METHODS.mirrorSnapshot)
  // A window writes the launch settings over the Studio protocol now, not this tunnel.
  assert.equal(typeof mirror.launchSettings.settings.cliRuntimes, 'object')
  assert.ok(Array.isArray(mirror.state.workspaces))

  // A GitHub token is sealed by the shell's keychain, byte for byte.
  await shellRpc.call(SERVER_METHODS.githubToken, { op: 'write', token: 'ghp_example' })
  assert.deepEqual(readFileSync(join(dataDir, 'github-token.bin')), keychainSeal('ghp_example'))
  assert.equal(await shellRpc.call(SERVER_METHODS.githubToken, { op: 'resolve' }), 'ghp_example')

  const info = await shellRpc.call<{ cipher: string; pid: number }>(SERVER_METHODS.info)
  assert.equal(info.pid, process.pid)
  assert.match(info.cipher, /desktop keychain/)

  // What a quit would stop: no chat has a turn running here, and no schedule or watch.
  assert.deepEqual(await shellRpc.call(SERVER_METHODS.quitStops), { agents: 0, schedules: [], watches: [] })

  // The CLIs' version check is this server's: the shell's hourly comparison
  // runs here (and with checks not switched on yet, asks the registry nothing).
  const versions = await shellRpc.call<{ ok: boolean; advisories?: unknown }>(SERVER_METHODS.cliVersionsRefresh)
  assert.deepEqual([versions.ok, versions.advisories], [true, {}])

  // The worktree pool is this server's: the shell's `agent.launch` has its
  // worktree cut here, from the pool, and listed among its leases. A window
  // reaches the pool over the Studio protocol (`worktrees.*`), never this
  // tunnel.
  const tunnelled = await window.invoke('worktree-pool:settings-get')
  assert.equal(tunnelled.ok, false, JSON.stringify(tunnelled))
  const repo = await gitProject(join(scratch, 'repos'))
  const cut = await shellRpc.call<{ worktreePath?: string; branch?: string; error?: string }>(
    SERVER_METHODS.createAgentWorktree,
    { workspaceRoot: repo, name: 'launched' },
  )
  assert.equal(cut.error, undefined, cut.error ?? '')
  assert.equal(cut.branch, 'agent/launched')
  assert.ok(cut.worktreePath && worktreesOf(repo).includes(realpathSync(cut.worktreePath)), 'cut from the pool')

  // An agent this server's shell launched calls `worktree.lease` and
  // `worktree.release` over the gateway socket, as this very orchestration's
  // agents do: the gateway's own tools now, not a toolset the shell offers.
  const created = await studio.request('workspaceSync.dispatch', {
    commandId: 'lease-ws-created',
    windowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: {
        workspace: projectWorkspace('lease-ws', repo),
        windowId: 'primary',
        insert: { kind: 'folder_head', folderPath: repo },
        activate: false,
      },
    },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  applyGatewayLaunchTokenChange({
    digest: createHash('sha256').update('lease-agent-token').digest('hex'),
    identity: { workspaceId: 'lease-ws', agentId: 'agent-lease' },
  })
  const mcp = await mcpSession(ready.gateway.socketPath)
  await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  const connected = await mcp.call('sprintengine.studio/connect', {
    workspaceId: 'lease-ws',
    agentId: 'agent-lease',
    launchToken: 'lease-agent-token',
  })
  assert.equal(connected.error, undefined, JSON.stringify(connected))
  const tools = ((await mcp.call('tools/list')).result?.tools as Array<{ name: string }>).map((tool) => tool.name)
  assert.ok(tools.includes('worktree.lease') && tools.includes('worktree.release'), tools.join(', '))
  // The terminal and agent tools are the gateway's own too, not a toolset the shell offers.
  assert.ok(tools.includes('terminal.list') && tools.includes('agent.launch'), tools.join(', '))
  // And the artifacts tools: the server publishes, over the setting it holds.
  assert.ok(tools.includes('artifacts.publish') && tools.includes('artifacts.list'), tools.join(', '))
  const listed = await mcp.call('tools/call', { name: 'terminal.list', arguments: {} })
  assert.equal(listed.result?.isError ?? false, false, JSON.stringify(listed))
  const leasedOverMcp = await mcp.call('tools/call', { name: 'worktree.lease', arguments: { name: 'over-mcp' } })
  assert.equal(leasedOverMcp.result?.isError ?? false, false, JSON.stringify(leasedOverMcp))
  const leasedPath = (leasedOverMcp.result?.structuredContent as { path: string; branch: string }).path
  assert.equal((leasedOverMcp.result?.structuredContent as { branch: string }).branch, 'agent/over-mcp')
  assert.ok(worktreesOf(repo).includes(realpathSync(leasedPath)), 'a slot of the pool')
  // The release is the holder check: it answers `released` only to the agent
  // and chat holding the lease, so the launch token's identity is the holder.
  const releasedOverMcp = await mcp.call('tools/call', { name: 'worktree.release', arguments: { path: leasedPath } })
  assert.equal(
    (releasedOverMcp.result?.structuredContent as { released: boolean }).released,
    true,
    JSON.stringify(releasedOverMcp),
  )
  mcp.close()
  applyGatewayLaunchTokenChange({
    digest: createHash('sha256').update('lease-agent-token').digest('hex'),
    identity: null,
  })

  // The drain runs every leg and lets the directory go.
  hub.dispatch({ t: 'shutdown', drain: true, budgetMs: 8_000 }, [])
  assert.equal(await exit, 0)
  const legs = fromServer.filter((frame) => frame.t === 'shutdown-progress').map((frame) => frame.leg)
  assert.equal(legs[0], 'modules (begin)')
  // The ptys end after the chats' transcripts are flushed and before the directory goes.
  assert.ok(legs.indexOf('terminals') > legs.indexOf('chat transcripts'), legs.join(', '))
  assert.ok(legs.indexOf('terminals') < legs.indexOf('data directory'))
  assert.equal(legs.at(-1), 'data directory')
  assert.ok(legs.indexOf('chat transcripts') < legs.indexOf('data directory'))
  // The pool's installs stop with the new work, and the pool lets its lock go before the directory.
  assert.ok(legs.indexOf('dependency installs') > 0 && legs.indexOf('dependency installs') < legs.indexOf('chats'))
  assert.ok(legs.indexOf('worktree pool') > legs.indexOf('chats'))
  assert.ok(legs.indexOf('worktree pool') < legs.indexOf('data directory'))
  assert.equal(
    fromServer.filter((frame) => frame.t === 'shutdown-progress').every((frame) => !frame.failed),
    true,
    JSON.stringify(fromServer.filter((frame) => frame.t === 'shutdown-progress')),
  )
})

/** One newline-delimited JSON-RPC exchange per call, on one gateway connection. */
/** A desktop window's Studio client: a ticket the shell buys for it, then a socket saying the window's origin. */
async function windowStudio(shellRpc: { call<T>(method: string, params: unknown): Promise<T> }) {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  const WindowWebSocket = class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin: 'file://' } }) as never
    }
  } as unknown as StudioWebSocketConstructor
  const client = await connectStudio({
    transport: webSocketTransport({
      ticket: () =>
        shellRpc.call<StudioWindowTicket>(SERVER_METHODS.windowTicket, { windowKey: 'window-1-1', origin: 'file://' }),
      WebSocket: WindowWebSocket,
    }),
    client: { name: 'desktop-server test window' },
    reconnect: false,
  })
  windows.push(client)
  return client
}

async function mcpSession(socketPath: string) {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
  const replies = createInterface({ input: socket })[Symbol.asyncIterator]()
  let id = 0
  return {
    async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`)
      for (;;) {
        const next = await replies.next()
        assert.equal(next.done, false, 'the gateway closed the connection')
        const message = JSON.parse(next.value) as Record<string, any>
        if (message.id === id) return message
      }
    },
    close: () => socket.end(),
  }
}

/** A project's workspace record, as a window creates one. */
function projectWorkspace(id: string, folderPath: string) {
  return {
    id,
    name: 'app',
    mode: 'standard',
    folderPath,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  }
}

/** The worktrees git lists for a repository, real paths. */
function worktreesOf(repo: string): string[] {
  return execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)))
}

/** A project cloned from an origin of its own, as a person's checkout is. */
async function gitProject(dir: string): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, stdio: 'ignore' })
  const seed = join(dir, 'seed')
  mkdirSync(seed, { recursive: true })
  run(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'README.md'), '# app\n')
  run(seed, 'add', '.')
  run(seed, 'commit', '-q', '-m', 'init')
  run(dir, 'clone', '-q', '--bare', seed, join(dir, 'origin.git'))
  run(dir, 'clone', '-q', join(dir, 'origin.git'), join(dir, 'app'))
  return realpathSync(join(dir, 'app'))
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let tries = 0; tries < 3_000; tries++) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition not met')
}
