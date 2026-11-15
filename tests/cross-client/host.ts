import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { writeTailnetSettings } from '../../src/main/automation/tailnet/tailnet-settings'
import { defaultAgent, type AgentState } from '../../src/shared/agent-state'
import { readStudioEnvironmentId } from '../../src/server/environment/environment-id'
import type { StudioServer, StudioServerOptions } from '../../src/server/studio-server'
import type { StudioContainersDomain } from '../../src/server/rpc/studio-containers'
import type { ContainerSummary } from '../../packages/studio-protocol/src/public'
import { GATE_WINDOW_ORIGIN } from './client'

// The server host: its own process, which requires the built Studio server
// (`out/server/server.cjs`, `npm run build:server`) and starts it on the gate's
// data directory, the way the desktop's server process and the existing smoke
// fixture do. It is what the gate kills and starts again for "server restart".
//
// Beside the server it stands in for one thing only: the Electron shell's
// window tickets (src/main/ipc/studio-window-ticket-ipc.ts), which main asks
// the server for on a window's behalf (`rpc.windowTicket`). Here a ticket is
// asked for on a socket, one per request; the window then opens its WebSocket
// to the server's real window listener, as a desktop window does.
//
// It talks to the gate on stdin and stdout, one JSON object per line.

export type HostConfig = {
  bundle: string
  dataDir: string
  appRoot: string
  repository: string
  webPort: number
  /** The addresses the web listener is also reached by (the embed's cutter). */
  publicOrigins: string[]
  tailnetPort: number
  shellSocket: string
  /** Make the project and turn the tailnet listener on: the first boot only. */
  firstBoot: boolean
}

export type HostReady = {
  pid: number
  workspaceId: string
  environmentId: string
  web: string
  /** The window listener's address (`ws://127.0.0.1:<port>`); a restart moves it. */
  window: string
  tailnet: { running: boolean; detail: string }
}

export type HostRequest =
  | { id: number; op: 'pairing' }
  | { id: number; op: 'transcript'; workspaceId: string; agentId: string }
  | { id: number; op: 'recordChat'; workspaceId: string; agentId: string; patch: Partial<AgentState> }
  | { id: number; op: 'stop' }

const config = JSON.parse(process.argv[2] ?? '{}') as HostConfig

function say(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** The shell's window tickets: each socket is one request, answered with one ticket line. */
function startShellBroker(server: StudioServer) {
  rmSync(config.shellSocket, { force: true })
  const broker = createServer((socket: Socket) => {
    socket.on('error', () => undefined)
    server.rpc
      .windowTicket({ windowKey: 'gate-window', origin: GATE_WINDOW_ORIGIN })
      .then((ticket) => socket.end(`${JSON.stringify(ticket)}\n`))
      .catch(() => socket.destroy())
  })
  broker.listen(config.shellSocket)
  return broker
}

/**
 * Main's containers, stood in: what a desktop's `ContainerChats` answers,
 * kept in memory, with no Docker. The gate holds who reaches the methods and
 * that the window's own code drives them; what they do on a host is the
 * Docker suite's (`container-chats.docker.test.ts`).
 */
function fakeContainers(): StudioContainersDomain {
  const made = new Map<string, ContainerSummary>()
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((listener) => listener())
  let token: string | null = null
  let next = 0
  const ready = {
    state: 'ready' as const,
    words: 'Docker 29.2.1 is running on this computer (stand-in).',
    imageReady: true,
    canStart: null,
  }
  return {
    status: async () => ready,
    startDocker: async () => ready,
    create: async (request) => {
      const id = (++next).toString(16).padStart(16, '0')
      const folder = `/home/node/work/${request.folder?.split('/').pop() ?? 'work'}`
      made.set(id, {
        id,
        name: `sprintengine-${id}`,
        host: request.host,
        hostLabel: 'this computer',
        status: 'Up 1 second',
        repo: request.folder ? { source: request.folder, path: folder, branch: `studio/container-${id.slice(-8)}`, base: null } : null,
      })
      changed()
      return { ok: true, id, label: request.label, folder }
    },
    list: async () => [...made.values()],
    push: async (id) => (made.has(id) ? { ok: true, message: 'Branch pushed (stand-in).' } : { ok: false, message: 'No such container.' }),
    remove: async (target) => {
      const id = 'id' in target ? target.id : target.name.replace(/^sprintengine-/u, '')
      const removed = made.delete(id)
      changed()
      return removed ? { ok: true } : { ok: false, message: 'No such container.' }
    },
    tokenStatus: async () => ({ set: token !== null, kept: token ? 'session' : null }),
    setToken: async (value) => ((token = value), { ok: true }),
    clearToken: async () => ((token = null), { ok: true }),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

async function main(): Promise<void> {
  // The tailnet listener is off until a person turns it on; this is that.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  if (config.firstBoot)
    writeTailnetSettings(config.dataDir, { enabled: true, port: config.tailnetPort, notifications: false })
  const { startStudioServer } = require(config.bundle) as {
    startStudioServer(options: StudioServerOptions): Promise<StudioServer>
  }
  const server = await startStudioServer({
    dataDir: config.dataDir,
    logsDir: `${config.dataDir}/logs`,
    version: 'cross-client-gate',
    packaged: false,
    appRoot: config.appRoot,
    // The chat methods a window uses are served beside the web listener, and
    // the embed is reached through it.
    web: { port: config.webPort, publicOrigins: config.publicOrigins, staticDir: null },
    // No Tailscale on a CI runner: the real listener, on loopback.
    tailnetBindAddress: '127.0.0.1',
    // A desktop's containers, which its shell runs Docker for.
    containers: fakeContainers(),
    log: (message) => process.stderr.write(`[server] ${message}\n`),
  })
  const { core } = server
  let workspaceId = core.workspaceRegistry.getRecords().find((record) => record.folderPath === config.repository)?.id
  if (!workspaceId) {
    const created = core.workspaceSyncService.createWorkspace({ name: 'gate', folderPath: config.repository }, 'system')
    if (!created.ok) throw new Error(`The project could not be made: ${created.message}`)
    workspaceId = created.result.workspace.id
  }
  const broker = startShellBroker(server)
  // The window listener starts on the first ticket; the gate's cutter needs its address now.
  const boot = await server.rpc.windowTicket({ windowKey: 'gate-boot', origin: GATE_WINDOW_ORIGIN })
  server.rpc.revokeWindow('gate-boot')
  const tailnet = server.gateway.getTailnetStatus()
  const ready: HostReady = {
    pid: process.pid,
    workspaceId,
    environmentId: readStudioEnvironmentId(config.dataDir),
    web: server.ready.web ?? '',
    window: new URL(boot.url).origin,
    tailnet: { running: tailnet.running, detail: tailnet.lastError ?? tailnet.endpoint ?? '' },
  }
  say({ ready })

  const stop = async () => {
    broker.close()
    await server.stop()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line) as HostRequest
    void (async () => {
      try {
        if (request.op === 'pairing') {
          const offer = server.gateway.offerTailnetPairing()
          say({ id: request.id, result: { token: offer.token } })
        } else if (request.op === 'transcript') {
          const read = await core.conversations.readTranscript({
            workspaceRoot: config.repository,
            workspaceId: request.workspaceId,
            agentId: request.agentId,
          })
          if (!read.ok) throw new Error(read.message)
          say({ id: request.id, result: read.events.map((event) => ({ seq: event.seq, type: event.type })) })
        } else if (request.op === 'recordChat') {
          // What a window's New chat writes to main over IPC (workspace sync).
          const written = core.workspaceSyncService.updateWorkspaceAgent(
            request.workspaceId,
            request.agentId,
            { ...defaultAgent(request.agentId, request.agentId), ...request.patch },
            'system',
          )
          if (!written.ok) throw new Error(written.message ?? 'The chat could not be recorded.')
          say({ id: request.id, result: true })
        } else if (request.op === 'stop') {
          say({ id: request.id, result: true })
          await stop()
        }
      } catch (error) {
        say({ id: request.id, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}

main().catch((error: unknown) => {
  say({ fatal: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  process.exit(1)
})
