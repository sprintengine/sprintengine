import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { writeTailnetSettings } from '../../src/main/automation/tailnet/tailnet-settings'
import { defaultAgent, type AgentState } from '../../src/shared/agent-state'
import { readStudioEnvironmentId } from '../../src/server/environment/environment-id'
import type { StudioServer, StudioServerOptions } from '../../src/server/studio-server'
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
