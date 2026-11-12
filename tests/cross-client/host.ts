import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

import { writeTailnetSettings } from '../../src/main/automation/tailnet/tailnet-settings'
import { defaultAgent, type AgentState } from '../../src/shared/agent-state'
import { readStudioEnvironmentId } from '../../src/server/environment/environment-id'
import type { StudioFramePort } from '../../src/server/rpc/studio-frame-port'
import type { StudioServer, StudioServerOptions } from '../../src/server/studio-server'

// The server host: its own process, which requires the built Studio server
// (`out/server/server.cjs`, `npm run build:server`) and starts it on the gate's
// data directory, the way the desktop's server process and the existing smoke
// fixture do. It is what the gate kills and starts again for "server restart".
//
// Beside the server it stands in for one thing only: the Electron shell's
// broker of a window's connection (src/main/ipc/studio-connection-ipc.ts),
// which hands a port to `rpc.connectWindow` and the window the connection's
// id and ticket. Here the port is a socket per connection, one frame per line.
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

/** The shell's broker: each socket is one window connection, its first line the id and ticket. */
function startShellBroker(server: StudioServer) {
  rmSync(config.shellSocket, { force: true })
  const broker = createServer((socket: Socket) => {
    const frameListeners: Array<(frame: string) => void> = []
    const closeListeners: Array<() => void> = []
    let closed = false
    const end = () => {
      if (closed) return
      closed = true
      for (const listener of closeListeners.splice(0)) listener()
    }
    socket.on('close', end).on('error', end)
    const port: StudioFramePort = {
      post: (frame) => {
        if (!closed) socket.write(`${frame}\n`)
      },
      onFrame: (listener) => void frameListeners.push(listener),
      onClose: (listener) => (closed ? listener() : void closeListeners.push(listener)),
      close: () => {
        socket.destroy()
        end()
      },
    }
    let connection: { connectionId: string; ticket: string }
    try {
      connection = server.rpc.connectWindow(port)
    } catch {
      socket.destroy()
      return
    }
    socket.write(`${JSON.stringify(connection)}\n`)
    createInterface({ input: socket }).on('line', (line) => {
      for (const listener of frameListeners) listener(line)
    })
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
  const tailnet = server.gateway.getTailnetStatus()
  const ready: HostReady = {
    pid: process.pid,
    workspaceId,
    environmentId: readStudioEnvironmentId(config.dataDir),
    web: server.ready.web ?? '',
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
