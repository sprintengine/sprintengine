import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { connect, StudioError, webSocketTransport, type StudioClient } from '../../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../../packages/studio-protocol/src/environment'
import { installTree, wslNodeDigests } from '../../src/main/hosts/wsl-helper-runtime'
import { streamedAppPayload, WSL_DATA_REL } from '../../src/main/hosts/wsl-install'
import { WSL_NODE_VERSION } from '../../src/main/hosts/wsl-node-runtime'
import type { WslRunner } from '../../src/main/hosts/wsl-runner'
import type { RunOutcome } from '../../src/main/process-run'
import { createStudioConversationParts } from '../../src/renderer/src/components/panels/agentChat/studioChat'
import { readTreeBuild } from '../../src/server/wsl/desktop-wsl-servers'
import { createWslEnvironmentAccess } from '../../src/server/wsl/wsl-environment-access'
import { createWslEnvironmentManager, type WslServerConnection } from '../../src/server/wsl/wsl-environment-manager'
import { createWslLaunchTokens } from '../../src/server/wsl/wsl-launch-tokens'
import { createWslMachineAccess } from '../../src/server/wsl/wsl-machine-client'
import { machineSpellingOf } from '../../src/shared/machine-spelling'
import { routeStudioClient } from '../../src/shared/machine-studio-client'
import { GATE_WINDOW_ORIGIN, MOCK_PROVIDER, type GateClient } from './client'
import { approvalAfter, Feed, isReplyTo, isUserMessage, resolvedAfter, type GateEvent } from './feed'
import { followChat, newChatThere, okOf, until, windowWebSocket } from './machine-chat'
import type { Matrix } from './matrix'

// A WSL distribution, as far as a machine without WSL can show one: `sh`
// stands in for `wsl.exe`, in a home of the distribution's own with the pinned
// Node there (this machine's, marked ready), as the WSL server suites do. The
// rest is the desktop's own code: the server tree as `npm run build:server:wsl`
// builds it, installed by the real launch and commit scripts and started with
// a real envelope by the desktop's environment manager, and wired as the
// desktop's core wires it on Windows: the window's route to the distribution's
// own Studio (`windowTicket`, a 127.0.0.1 route spliced onto the front door),
// the launch tokens of its terminal agents, and git, the home and watches by
// the environment methods on the core's owner connection.
//
// The window's client of that Studio, over that route, drives a chat on the
// fake provider; a terminal agent's own MCP bridge, started as a WSL launch
// starts it, proves itself by its token; the server is killed and the window
// comes back by itself and by its cursor. And the phone and a paired desktop,
// paired with the gate's desktop, are held off it: no relay route to a
// distribution is left, and none is served.

export const WSL_TRANSPORT = "Studio protocol (window client over the desktop's loopback route, WSL environment)"

const DISTRO = 'Ubuntu'
const ROUTE = `wsl:${DISTRO}`
// Not the installed app's own profile: its data is `data-<id>`.
const PROFILE = '0123456789ab'
const WINDOW_KEY = 'window-gate-wsl'

const ok = okOf('wsl')

/**
 * `wsl.exe` as `sh`, in the distribution's home: a shell with its script on
 * stdin, a script run to its end, or one argv with a body on its stdin.
 */
function fakeWslRunner(home: string): WslRunner {
  const env = { PATH: process.env.PATH, HOME: home, WSL_DISTRO_NAME: DISTRO }
  const run = (file: string, args: readonly string[], body: Buffer | Readable): Promise<RunOutcome> =>
    new Promise((resolve) => {
      const child = spawn(file, args, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, timedOut: false }))
      child.stdin.on('error', () => undefined)
      if (Buffer.isBuffer(body)) child.stdin.end(body)
      else body.pipe(child.stdin)
    })
  return {
    spawnShell() {
      const child = spawn('sh', ['-s'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.on('error', () => undefined)
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        pid: child.pid,
        kill: () => child.kill('SIGKILL'),
        once: (event: 'close' | 'error', listener: (...args: never[]) => void) =>
          child.once(event, listener as (...args: unknown[]) => void),
      } as ReturnType<WslRunner['spawnShell']>
    },
    runScript: (_distro, script) => run('sh', ['-s'], Buffer.from(`${script}\n`)),
    runExec: (_distro, argv, body) => run(argv[0]!, argv.slice(1), body),
  }
}

/** The distribution's home: the pinned Node already there, and a repository with one commit. */
function fakeHome(dir: string): { home: string; repo: string } {
  const runtime = join(dir, WSL_DATA_REL, 'runtime', `node-${WSL_NODE_VERSION}`)
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  symlinkSync(process.execPath, join(runtime, 'bin', 'node'))
  writeFileSync(join(runtime, '.ready'), wslNodeDigests()[0]!)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, HOME: dir } })
  git('init', '-q')
  git('config', 'user.name', 'Developer')
  git('config', 'user.email', 'dev@example.com')
  writeFileSync(join(repo, 'README.md'), 'A project in WSL.\n')
  git('add', '.')
  git('commit', '-qm', 'Initial files')
  return { home: dir, repo }
}

/** One HTTP upgrade, answered by its status and Studio's error code, opening nothing. */
function upgrade(url: string, origin: string | null): Promise<{ status: number; code: string | undefined }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const asked = request({
      host: '127.0.0.1',
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin === null ? {} : { Origin: origin }),
      },
    })
    asked.on('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0, code: response.headers['x-studio-error'] as string | undefined })
    })
    asked.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve({ status: 101, code: undefined })
    })
    asked.on('error', reject)
    asked.end()
  })
}

/** An agent's own MCP connection to a server's gateway: one newline-delimited JSON-RPC exchange per call. */
async function agentSession(socketPath: string) {
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject))
  socket.setEncoding('utf8')
  const waiting = new Map<number, (message: Record<string, any>) => void>()
  let buffer = ''
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, any>
      buffer = buffer.slice(newline + 1)
      waiting.get(message.id as number)?.(message)
    }
  })
  let id = 0
  return {
    /** The answer, or null when none comes within a second (a connect that binds answers none). */
    call: (method: string, params: Record<string, unknown> = {}) =>
      Promise.race([
        new Promise<Record<string, any>>((resolve) => {
          const next = ++id
          waiting.set(next, resolve)
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`)
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]),
    close: () => socket.end(),
  }
}

/** The error code an ask was refused with, or `answered` when it was not refused. */
async function refusalOf(asked: Promise<unknown>): Promise<string> {
  try {
    await asked
    return 'answered'
  } catch (error) {
    // By its code, not its class: the phone's bundle carries its own copy of the runtime.
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : String(error)
  }
}

export async function runWslLeg(input: {
  /** The server tree as `npm run build:server:wsl` builds it, built on the first ask. */
  serverTree: () => string
  scratch: string
  matrix: Matrix
  version: string
  /** The paired devices of the gate's desktop, which must not reach the distribution. */
  devices: GateClient[]
}): Promise<void> {
  const { matrix } = input
  matrix.client('wsl', WSL_TRANSPORT, [
    "wsl.exe: `sh` runs each command in a home of the distribution's own on this machine, and the pinned Node there is this machine's own",
    "the desktop's core: the gate wires its WSL pieces itself (the environment manager, the window route, the launch tokens, git and the home), as the core wires them on Windows",
    "the terminal agent: its MCP bridge alone, started from the distribution's server tree as a WSL launch starts it",
  ])
  const tree = input.serverTree()
  const payload = streamedAppPayload([{ dir: tree, into: '' }])
  const treeBuild = readTreeBuild(tree)
  // Short: the server's sockets live under the home.
  const { home, repo } = fakeHome(join(input.scratch, 'w'))
  const runner = fakeWslRunner(home)
  const connected: Array<(connection: WslServerConnection) => void> = []
  const manager = createWslEnvironmentManager({
    runner,
    listDistros: async () => ({
      distros: [{ name: DISTRO, isDefault: true, state: 'Running', version: 2 }],
      at: Date.now(),
    }),
    app: { version: input.version, buildStamp: '', channel: 'nightly' },
    profile: { id: PROFILE, isDefault: false },
    payload: () => payload,
    treeBuild: () => treeBuild,
    nodeDigests: wslNodeDigests,
    installNode: async () => {
      throw new Error('Node is already in the fake distribution.')
    },
    install: (distro, asked) => installTree(distro, asked, input.version, runner),
    transportFor: () => 'auto',
    onConnected: (connection) => {
      for (const listener of connected) listener(connection)
    },
  })
  // As the core wires them (studio-core.ts): a new connection is told every
  // live launch token; git and the home go over the owner connection; a
  // window's ticket comes from the access, which is what main asks.
  const tokens = createWslLaunchTokens({
    connect: (distro) => manager.connect(distro),
    current: (distro) => manager.current(distro),
  })
  connected.push((connection) => tokens.connected(connection.distro, connection))
  const machine = createWslMachineAccess(
    () => manager,
    (distro) => new Error(`Studio cannot start a server in ${distro} on this computer.`),
  )
  const access = createWslEnvironmentAccess({ manager })
  const spelling = machineSpellingOf(ROUTE)!
  const serverPid = () =>
    (
      JSON.parse(readFileSync(join(home, WSL_DATA_REL, `data-${PROFILE}`, 'run', 'studio.lock'), 'utf8')) as {
        pid: number
      }
    ).pid

  // The window's client of the distribution's Studio: each connection on a
  // ticket main asks the desktop's WSL access for, which starts the server if
  // it is not running and names this PC's route to it.
  let windowClient: Promise<StudioClient> | null = null
  const windowStudio = async (): Promise<StudioClient> => {
    windowClient ??= connect({
      transport: webSocketTransport({
        ticket: async () => {
          const ticket = await access.windowTicket(DISTRO, { windowKey: WINDOW_KEY, origin: GATE_WINDOW_ORIGIN })
          if (!ticket.ok) throw new StudioError('unavailable', ticket.message)
          return { url: ticket.url, token: ticket.token }
        },
        WebSocket: windowWebSocket(),
      }),
      client: { name: 'Studio window' },
      // As the window's environment client (environmentStudio.ts) connects.
      reconnect: { initialDelayMs: 500, maxDelayMs: 30_000 },
      parkWhenOffline: false,
    })
    return routeStudioClient(await windowClient, ROUTE)
  }
  const parts = createStudioConversationParts(windowStudio)
  // The chat as the window names it: its folder spelled as Windows opens it.
  const key = { workspaceRoot: spelling.fromMachine(repo), workspaceId: 'w-wsl', agentId: 'wsl-chat' }
  const feed = new Feed('wsl')
  let stopFollowing: () => void = () => undefined
  let closeWatch: () => void = () => undefined
  let sessionId = ''
  const send = (message: string) =>
    // Answered when the turn ends; a call in flight when the server goes fails with it, as in the app.
    void parts.send({ sessionId, message, commandId: `wsl-${Date.now()}` } as never).catch(() => undefined)
  const answer = async (text: string) => {
    await feed.until((each) => approvalAfter(each, text) !== undefined, `the approval after "${text}"`, 30_000)
    const requestId = String(approvalAfter(feed, text)!.payload?.requestId)
    ok(await parts.respond({ sessionId, requestId, approved: true }), 'answer')
    await feed.until((each) => resolvedAfter(each, requestId), `"${text}" ending`, 30_000)
  }
  /** Whether a gateway connection presenting `token` first is bound to its agent: a second launch's token is then refused. */
  const bound = async (agent: { workspaceId: string; agentId: string }, token: string, other: string) => {
    const connection = manager.current(DISTRO)
    if (!connection) throw new Error('wsl: the server is not running')
    const { socketPath } = JSON.parse(
      readFileSync(join(connection.dataDir, 'sprintengine-studio-mcp-info.json'), 'utf8'),
    ) as { socketPath: string }
    const session = await agentSession(socketPath)
    try {
      void session.call('sprintengine.studio/connect', { ...agent, launchToken: token })
      const again = await session.call('sprintengine.studio/connect', { ...agent, launchToken: other })
      return /already belongs to another agent/u.test(String(again?.error?.message))
    } finally {
      session.close()
    }
  }
  const agent = { workspaceId: key.workspaceId, agentId: 'wsl-terminal', cliId: 'claude-code' }
  let liveToken: { token: string; sent: Promise<unknown> } | null = null

  try {
    await matrix.run('wsl', 'create', async () => {
      const client = await windowStudio()
      if (client.welcome.environment.hostKind !== 'wsl')
        throw new Error(`wsl: the window reached a ${client.welcome.environment.hostKind} Studio`)
      if (client.welcome.environment.id !== manager.current(DISTRO)?.environmentId)
        throw new Error("wsl: the window's Studio is not the distribution's")
      sessionId = await newChatThere({ leg: 'wsl', label: DISTRO, client, parts, key })
      stopFollowing = followChat(parts, key, feed)
      await feed.until((each) => each.syncs > 0, 'the chat followed', 30_000)
    })

    const first = 'turn in WSL'
    await matrix.run('wsl', 'stream', async () => {
      send(first)
      await feed.until(
        (each) => each.find(isReplyTo(first)) !== undefined && approvalAfter(each, first) !== undefined,
        `"${first}" streamed`,
        30_000,
      )
    })
    await matrix.run('wsl', 'approval', () => answer(first))

    // A message scheduled from the window goes from the distribution's own Studio at its time.
    await matrix.run('wsl', 'schedule', async () => {
      const text = 'scheduled in WSL'
      ok(await parts.scheduleSend({ key, message: text, sendAt: Date.now() + 2_000 }), 'schedule a message')
      await feed.until((each) => each.find(isUserMessage(text)) !== undefined, `"${text}" sent at its time`, 30_000)
      await answer(text)
    })

    // A WSL terminal agent: its launch token told to the distribution's
    // Studio by the desktop, and its MCP bridge, run from the server's tree by
    // the distribution's Node as the launch's MCP entry starts it, reaching
    // that Studio's gateway. The token proves the agent; revoked, it proves nothing.
    await matrix.run('wsl', 'launch', async () => {
      const connection = await manager.connect(DISTRO)
      const issued = tokens.issue(DISTRO, agent)
      await issued.sent
      const bridge = join(connection.terminals.resourcesDir, 'automation', 'mcp-stdio-bridge.mjs')
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(connection.terminals.nodePath, [bridge], {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            SPRINTENGINE_USER_DATA_DIR: connection.dataDir,
            SPRINTENGINE_WORKSPACE_ID: agent.workspaceId,
            SPRINTENGINE_AGENT_ID: agent.agentId,
            SPRINTENGINE_AGENT_CLI: agent.cliId,
            SPRINTENGINE_MCP_CHANNEL_TOKEN: issued.token,
          },
        })
        let text = ''
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
          if (text.includes('\n')) child.stdin.end()
        })
        child.on('error', reject)
        child.on('close', () => {
          clearTimeout(timer)
          resolve(text)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
      })
      const listed = JSON.parse(out.split('\n')[0] || '{}') as { result?: { tools?: unknown[] } }
      if (!listed.result?.tools?.length)
        throw new Error(`wsl: the bridge got no tools from the gateway: ${out.slice(0, 200)}`)
      const second = tokens.issue(DISTRO, { workspaceId: key.workspaceId, agentId: 'wsl-terminal-2' })
      await second.sent
      if (!(await bound(agent, issued.token, second.token)))
        throw new Error("wsl: the launch token did not prove its agent at the distribution's gateway")
      tokens.revoke(DISTRO, issued.token)
      await until(() => false, 300)
      if (await bound(agent, issued.token, second.token))
        throw new Error('wsl: a revoked launch token still proved its agent')
      liveToken = second
    })

    // Git, the home and a watch on the repository's git directory, as the
    // desktop's Git pane and Skills ask them: the environment methods on the
    // core's owner connection. Files, as the window reads them: its own
    // client, the paths spelled as Windows opens them.
    await matrix.run('wsl', 'machine', async () => {
      const where = await machine.home(DISTRO)
      if (where.home !== home) throw new Error(`wsl: the home is ${where.home}, not the distribution's`)
      writeFileSync(join(repo, 'README.md'), 'A project in WSL, changed.\n')
      const git = async (...args: string[]) => {
        const outcome = await machine.git(DISTRO, { cwd: repo, args, timeoutMs: 15_000 })
        if (outcome.code !== 0) throw new Error(`wsl: git ${args.join(' ')}: ${outcome.stderr || outcome.code}`)
        return outcome.stdout
      }
      if ((await git('log', '-1', '--format=%s')).trim() !== 'Initial files') throw new Error('wsl: git log read wrong')
      if (!(await git('status', '--porcelain')).includes(' M README.md'))
        throw new Error('wsl: git status did not see the change')
      const heard: Array<string | null> = []
      let failed = false
      if (!machine.watchPath) throw new Error('wsl: the machine access places no watches')
      const watch = machine.watchPath(
        DISTRO,
        join(repo, '.git'),
        true,
        (name) => heard.push(name),
        () => (failed = true),
      )
      closeWatch = watch.close
      await until(() => false, 1_000)
      await git('add', 'README.md')
      if (!(await until(() => heard.length > 0 || failed, 10_000)) || failed)
        throw new Error('wsl: the git directory watch heard nothing of the staging')
      watch.close()
      const client = await windowStudio()
      const read = await client.request('files.readText', { path: spelling.fromMachine(join(repo, 'README.md')) })
      if (read.text !== 'A project in WSL, changed.\n') throw new Error(`wsl: the window read "${read.text}"`)
      const listed = await client.request('files.listDirectory', { path: key.workspaceRoot })
      if (!listed.entries.some((entry) => entry.name === 'README.md'))
        throw new Error("wsl: the window's listing of the project has no README.md")
    })

    // The distribution's server is killed with the window on it. The window's
    // client notices, asks for a ticket again (which starts the server once
    // its crash backoff allows), and its follow catches up by its cursor; the
    // chat goes on in a session started again, and the restarted server is
    // told the launch tokens still live.
    await matrix.run('wsl', 'restart', async () => {
      const pid = serverPid()
      const before = { cursor: feed.cursor ?? 0, duplicates: feed.duplicates, resets: feed.resets, syncs: feed.syncs }
      process.kill(pid, 'SIGKILL')
      await feed.until((each) => each.syncs > before.syncs, 'the chat followed again after the restart', 90_000)
      const after = serverPid()
      if (after === pid) throw new Error('wsl: the server was not started again')
      const client = await windowStudio()
      const transcript = ok<{ page: { events: GateEvent[] } }>(
        await client.conversations.loadEarlier(key, Number.MAX_SAFE_INTEGER, 100),
        'transcript',
      ).page.events
      const held = new Set(feed.seqs)
      const lost = transcript.filter(
        (event) => typeof event.seq === 'number' && event.seq > before.cursor && !held.has(event.seq),
      )
      if (lost.length) throw new Error(`wsl: ${lost.length} event(s) never arrived`)
      if (feed.duplicates !== before.duplicates) throw new Error('wsl: events were handed over twice')
      if (feed.resets !== before.resets) throw new Error('wsl: it came back with a snapshot, not by its cursor')
      sessionId = ok<{ session: { sessionId: string } }>(
        await parts.startSession!({ ...key, ...MOCK_PROVIDER }),
        'start again',
      ).session.sessionId
      const text = 'after the restart in WSL'
      send(text)
      await answer(text)
      if (!feed.find(isUserMessage(first))) throw new Error('wsl: the chat lost its history')
      const live = liveToken as { token: string } | null
      if (live) {
        const third = tokens.issue(DISTRO, { workspaceId: key.workspaceId, agentId: 'wsl-terminal-3' })
        await third.sent
        if (!(await bound({ workspaceId: key.workspaceId, agentId: 'wsl-terminal-2' }, live.token, third.token)))
          throw new Error('wsl: the restarted server was not told the live launch token')
      }
    })

    // No paired device reaches the distribution through this desktop: the
    // relay route is gone. Each of the gate's devices, on its own connection
    // to the desktop it paired with, finds no method that lists or tickets a
    // distribution, and a ticket that names one buys only the desktop's own
    // Studio, whose listener serves no environment path. The distribution's
    // Studio serves windows of the desktop that holds it, on 127.0.0.1, and
    // no device path.
    await matrix.run('wsl', 'unreachable', async () => {
      const environmentId = manager.current(DISTRO)?.environmentId
      if (!environmentId) throw new Error('wsl: no server to stay away from')
      const wrong: string[] = []
      for (const device of input.devices) {
        const reach = device.device
        if (!reach) throw new Error(`wsl: ${device.id} has no reach of its own to check`)
        await reach.ask(async (client) => {
          const capabilities = client.welcome.capabilities as readonly string[]
          for (const capability of ['relayed-environments', 'device-tickets'])
            if (capabilities.includes(capability)) wrong.push(`${device.id} is offered ${capability}`)
          const listed = await refusalOf(client.request('environment.relayed' as never, {} as never))
          if (listed !== 'unknown_method') wrong.push(`${device.id}: environment.relayed was ${listed}`)
          const ticketed = await refusalOf(
            client.request(
              'environment.deviceTicket' as never,
              {
                environmentId,
                deviceId: device.id,
                name: device.label,
                scopes: [],
              } as never,
            ),
          )
          if (ticketed !== 'unknown_method') wrong.push(`${device.id}: environment.deviceTicket was ${ticketed}`)
        })
        const ticket = await reach.ticket(environmentId)
        const studio = new URL(ticket.url)
        if (studio.pathname !== '/tailnet/v1/studio')
          wrong.push(`${device.id}: naming the distribution bought a ticket for ${studio.pathname}`)
        const path = new URL(`/tailnet/v1/environments/${environmentId}/studio${studio.search}`, studio)
        // Not served: not found, or (a window's ticket) good for no path but the Studio socket.
        const opened = await upgrade(path.toString(), ticket.origin)
        if (opened.status !== 404 && opened.status !== 403)
          wrong.push(`${device.id}: the environment path answered ${opened.status}`)
      }
      for (const route of [`relay:${environmentId}`, `relay:desktop/${environmentId}`])
        if (parseEnvironmentRoute(route) !== null) wrong.push(`"${route}" is still a route`)
      const windowTicket = await access.windowTicket(DISTRO, { windowKey: WINDOW_KEY, origin: GATE_WINDOW_ORIGIN })
      if (!windowTicket.ok) throw new Error(`wsl: no window ticket: ${windowTicket.message}`)
      if (new URL(windowTicket.url).hostname !== '127.0.0.1')
        wrong.push(`the route to the distribution listens on ${new URL(windowTicket.url).hostname}`)
      const device = await upgrade(windowTicket.url.replace('/ws?', '/device?'), '')
      if (device.status !== 404) wrong.push(`the distribution's /device path answered ${device.status}`)
      const unlabelled = await access.windowTicket(DISTRO, { windowKey: WINDOW_KEY, origin: GATE_WINDOW_ORIGIN })
      if (!unlabelled.ok) throw new Error(`wsl: no window ticket: ${unlabelled.message}`)
      const asDevice = await upgrade(unlabelled.url, '')
      if (asDevice.status === 101)
        wrong.push("a socket saying no window's origin was let onto the distribution's Studio")
      if (wrong.length) throw new Error(`wsl: a device could reach the distribution: ${wrong.join('; ')}`)
    })
  } finally {
    stopFollowing()
    closeWatch()
    const lastWindow = windowClient as Promise<StudioClient> | null
    ;(await lastWindow?.catch(() => null))?.close()
    access.revokeWindow(WINDOW_KEY)
    await access.close()
    await manager.shutdown({ budgetMs: 5_000 })
  }
}
