import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { captureLoginEnv } from '../../../resources/wsl-helper/lib/login-env.mjs'
import { readStudioEnvironmentId } from '../environment/environment-id'
import { readDriveMountRoot } from '../wsl/drive-mount-root'
import { chatsAreWorking } from '../core/chats-working'
import { backgroundWorkOf, hasBackgroundWork } from '../core/background-work'
import { externalStudioUpdates, MANUAL_UPDATE_WORDS, type StudioUpdates } from '../update/studio-updates'
import { startStudioServer, type StudioServer, type StudioServerOptions } from '../studio-server'
import type { SignIns } from '../machine/machine-sign-in'
import { startFrontDoorListeners, type FrontDoorListeners } from '../wsl/front-door-listener'
import { createAgentStateRelay, type AgentStateRelay } from '../wsl/agent-state-relay'
import { createAgentStateListener, type AgentStateListener } from '../terminals/agent-state-listener'
import { resolveAgentStateSocketPath } from '../../main/agent-state-service'
import type { FrontDoorPurpose } from '../wsl/front-door-proof'
import { SERVER_EXIT, type FrontDoorReady, type ServerBootstrapEnvelope } from './envelope'
import { runShutdownLegs, type ServerStart } from './serve'
import { readHostId, writeServerRecord } from './server-record'
import { STUDIO_PROTOCOL_MIN_SUPPORTED, STUDIO_PROTOCOL_VERSION } from '../../../packages/studio-protocol/src/public'
import type { Duplex } from 'node:stream'

// A headless server's start from its envelope: the same core, gateway and
// owner socket `studio-server serve` runs, with the locations the envelope
// names instead of flags. Its secrets are its own key file (decision R12);
// a headless server never seals through a shell.
//
// A server inside a WSL distribution (phase 7) is one of these, with a front
// door: the Windows side's two ways in (front-door-listener.ts), both behind
// the mutual proof. An admitted connection asks for the conversation backend
// the Windows side routes this distribution's chats to, or for a Studio
// protocol connection with the shell role, over which the Windows side offers
// the toolsets its own shell offers it. It also relays what the desktop's WSL
// terminal agents report from inside the distribution (`agent-state`).

export function headlessServerOptions(
  envelope: ServerBootstrapEnvelope,
  log: (message: string) => void,
): StudioServerOptions {
  return {
    dataDir: envelope.dataDir,
    logsDir: envelope.logsDir,
    version: envelope.app.version,
    packaged: envelope.paths.isPackaged,
    resourcesDir: envelope.paths.resourcesDir,
    appRoot: envelope.paths.appPath,
    listen: envelope.listeners.gateway,
    // A detached server is an SSH machine's: one the desktop reaches over SSH.
    hostKind: envelope.wsl ? 'wsl' : envelope.detached ? 'ssh' : 'local',
    updates: headlessUpdates(envelope),
    // Where the desktop holds this server, its people have no terminal here.
    ...(envelope.wsl || envelope.detached ? { signIns: signInsLoaded } : {}),
    log,
  }
}

/**
 * How a headless server is updated. One a desktop installed (inside WSL, or
 * started over SSH) is replaced by that desktop's bootstrap when it next
 * connects, from the server the desktop carries; one started by hand is
 * updated by hand.
 */
export function headlessUpdates(envelope: Pick<ServerBootstrapEnvelope, 'wsl' | 'detached'>): StudioUpdates {
  if (envelope.wsl)
    return externalStudioUpdates(
      'bootstrap',
      'This Studio server runs inside WSL, and SprintEngine Studio on the Windows PC that started it updates it. Update the app on that PC, and it starts the new server.',
    )
  if (!envelope.detached) return externalStudioUpdates('manual', MANUAL_UPDATE_WORDS)
  if (envelope.detached.origin !== 'bootstrap')
    return externalStudioUpdates(
      'manual',
      `This Studio server was started by ${envelope.detached.origin}. Update SprintEngine Studio on its machine and restart that service, or stop it and let a desktop start its own.`,
    )
  return externalStudioUpdates(
    'bootstrap',
    'This Studio server was installed over SSH by SprintEngine Studio on a desktop. Update the app on that desktop, and it updates this server when it next connects.',
  )
}

// Loaded on first use, not at start: the desktop's bundle loads its
// dependencies from node_modules, and a server that never serves a machine's
// files must not need them to start.
let signInTable: SignIns | null = null
const signInsLoaded = (): Promise<SignIns> =>
  import('../machine/machine-sign-in').then(
    ({ createSignIns, resolveOnPath }) => (signInTable ??= createSignIns({ resolve: resolveOnPath })),
  )

/** What a WSL distribution's Studio relays to the desktop that holds it, beside its Studio. */
export type DistributionRelays = { agentState: AgentStateRelay }

/** Hand an admitted front-door connection to what it asked for. */
export function serveFrontDoorPurpose(
  server: Pick<StudioServer, 'core' | 'rpc'>,
  purpose: FrontDoorPurpose,
  stream: Duplex,
  relays: DistributionRelays | null = null,
): void {
  // A window's socket: the window listener admits it, or not, by the ticket
  // it minted for it.
  if (purpose === 'ws') {
    server.rpc.acceptWindowStream(stream)
    return
  }
  // The desktop's WSL terminal agents' reports. Only a distribution's Studio
  // relays them; anywhere else the stream is ended at once.
  if (purpose === 'agent-state') {
    if (relays) relays.agentState.attach(stream)
    else stream.destroy()
    return
  }
  // The ticket goes first, on its own line, before the Studio protocol starts:
  // the front door says hello with it.
  const { ticket } = server.rpc.connectShellStream(stream)
  stream.write(`${JSON.stringify({ t: 'ticket', ticket })}\n`)
}

/**
 * Inside WSL the server was started by `wsl.exe --exec` with almost no
 * environment: no profile has run, so PATH lacks where the person's CLIs live.
 * The helper's capture is read once here, the same fixed list of variables,
 * and laid over this process's environment before any chat can spawn.
 */
async function adoptLoginEnvironment(log: (message: string) => void): Promise<void> {
  const started = Date.now()
  const env = await captureLoginEnv({ ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}) })
  Object.assign(process.env, env)
  const took = Date.now() - started
  if (took > 7_000)
    log(`The login profile took ${Math.round(took / 1000)} s to read; chats use what it had set by then.`)
}

/**
 * A detached server's idle rule (decision R32): it stops once no client has
 * been connected for `idleMs` and it has no work, and never while it has.
 * Work is a chat working, and the work it does on its own (background-work.ts):
 * a schedule with a run to come, a pull request watch, a message kept to send
 * later, a resume after a usage limit. Stopping would end those unseen.
 */
export function createIdleRule(input: { idleMs: number; working: () => boolean; stop: (reason: string) => void }): {
  connections(count: number): void
  dispose(): void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (input.working()) {
        arm()
        return
      }
      input.stop(`No client for ${Math.round(input.idleMs / 60_000)} minutes and no work to do; stopping.`)
    }, input.idleMs)
    timer.unref?.()
  }
  arm()
  return {
    connections(count) {
      if (count > 0) {
        if (timer) clearTimeout(timer)
        timer = null
      } else arm()
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export const startHeadlessServer: ServerStart = async ({ envelope, log, requestExit }) => {
  // In parallel with the start: nothing spawns a CLI before `ready`. A server
  // started over `wsl.exe --exec` or an SSH session has run no profile, so
  // PATH lacks where the person's CLIs live.
  const loginEnvironment =
    envelope.wsl || envelope.detached ? adoptLoginEnvironment(log).catch(() => undefined) : Promise.resolve()
  const server = await startStudioServer({
    ...headlessServerOptions(envelope, log),
    // The desktop opened this directory and took its lock: it is the one
    // writer now, and this server leaves saying so.
    onDataDirLost: () =>
      requestExit(SERVER_EXIT.dataDirBusy, 'SprintEngine Studio opened this data directory; stopping.'),
  })

  let doors: FrontDoorListeners | null = null
  let frontDoor: FrontDoorReady | undefined
  // Inside WSL: the socket the desktop's WSL terminal agents report to, each
  // valid line relayed to the desktop. This Studio runs no terminals of its
  // own (its tree carries no pty), so the socket is free for them.
  const agentStateRelay = envelope.wsl ? createAgentStateRelay() : null
  let agentStateListener: AgentStateListener | null = null
  if (agentStateRelay && !server.core.agentTerminals) {
    const listener = createAgentStateListener({
      socketPath: resolveAgentStateSocketPath(envelope.dataDir),
      onFrame: (_frame, line) => agentStateRelay.send(line),
      logDiagnostic: (diagnostic) => log(`${diagnostic.title}: ${diagnostic.details ?? diagnostic.message}`),
    })
    await listener.start()
    if (listener.isRunning()) agentStateListener = listener
  }
  const relays: DistributionRelays | null = agentStateRelay ? { agentState: agentStateRelay } : null
  const detached = envelope.detached
  const idle =
    detached && detached.idleMs !== null
      ? createIdleRule({
          idleMs: detached.idleMs,
          working: () => chatsAreWorking(server.core.conversations) || hasBackgroundWork(backgroundWorkOf(server.core)),
          stop: (reason) => requestExit(SERVER_EXIT.ok, reason),
        })
      : null
  const door = envelope.listeners.frontDoor
  if (door && envelope.owner.tokenHash) {
    try {
      doors = await startFrontDoorListeners({
        tokenHash: envelope.owner.tokenHash,
        runDir: envelope.runDir,
        loopback: door.loopback,
        onAdmitted: (purpose, stream) => serveFrontDoorPurpose(server, purpose, stream, relays),
        ...(idle ? { onOpenCount: (count: number) => idle.connections(count) } : {}),
        log,
      })
    } catch (error) {
      idle?.dispose()
      agentStateRelay?.close()
      await agentStateListener?.stop()
      await server.stop()
      throw error
    }
    frontDoor = {
      port: doors.port,
      socketPath: doors.socketPath,
      driveMountRoot: envelope.wsl ? readDriveMountRoot() : null,
      agentStateSocket: agentStateListener?.socketPath ?? null,
    }
    if (doors.port === null && doors.socketPath === null) {
      await doors.close()
      agentStateRelay?.close()
      await agentStateListener?.stop()
      await server.stop()
      throw Object.assign(
        new Error('Neither of the front door’s ways in could open, so Windows cannot reach this server.'),
        {
          exitCode: SERVER_EXIT.temporary,
        },
      )
    }
  }

  await loginEnvironment
  const environmentId = readStudioEnvironmentId(envelope.dataDir)
  // The record the next client's probe and relay read. Written once the doors
  // are open, removed first when the server stops, so a record names a
  // server that can be reached (a crash leaves one, which the run lock's
  // dead holder tells apart).
  if (detached && frontDoor?.socketPath) {
    writeServerRecord(envelope.runDir, {
      v: 1,
      pid: process.pid,
      version: envelope.app.version,
      origin: detached.origin,
      startedBy: detached.startedBy,
      startedAt: new Date().toISOString(),
      hostId: readHostId(),
      environmentId,
      socketPath: frontDoor.socketPath,
      protocolVersion: STUDIO_PROTOCOL_VERSION,
      minProtocolVersion: STUDIO_PROTOCOL_MIN_SUPPORTED,
      dataDir: envelope.dataDir,
    })
  }
  return {
    environmentId,
    gatewaySocket: server.ready.gatewaySocket,
    tailnetBound: null,
    ...(frontDoor ? { frontDoor } : {}),
    stop: async ({ onLeg }) => {
      idle?.dispose()
      // A login still waiting on a person ends with the server.
      signInTable?.stopAll()
      if (detached) rmSync(join(envelope.runDir, 'server.json'), { force: true })
      // The front door first, so nothing new arrives while the core closes.
      if (doors) await runShutdownLegs([['front door', () => doors?.close()]], onLeg)
      agentStateRelay?.close()
      await agentStateListener?.stop()
      await server.stop(onLeg)
    },
  }
}
