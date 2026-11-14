import { randomBytes } from 'node:crypto'
import type { Duplex, Readable } from 'node:stream'

import type { WslListing } from '../../main/hosts/wsl-distro'
import {
  buildBridgeScript,
  buildLaunchScript,
  serverTreeName,
  tarArgs,
  type StreamedPayload,
  type NeedReport,
} from '../../main/hosts/wsl-install'
import type { WslRunner } from '../../main/hosts/wsl-runner'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import type { ServerBootstrapEnvelope } from '../bootstrap/envelope'
import { backoffDelayMs } from '../../shared/exponentialBackoff'
import { connect as connectStudio, type StudioClient } from '../../../packages/client-runtime/src/public'
import { hasBackgroundWork, parseBackgroundWork, type BackgroundWork } from '../core/background-work'
import { lineTransport, readTicket } from './studio-door'
import { connectLoopback, openBridge } from './front-door-client'
import { enterFrontDoor, ownerTokenHash, type FrontDoorPurpose } from './front-door-proof'
import {
  describeServerExit,
  startWslServer,
  wslServerPaths,
  type RunningWslServer,
  type WslServerExit,
  type WslServerStartDeps,
} from './wsl-server-starter'

// The Windows side's WSL servers (phase 7 spec, 5.2): one per distribution
// that has a chat to run, started on demand, reached through its front door,
// and let go when nothing has needed it for a while.
//
// Distributions are independent: each has its own server, data directory,
// transport and failure. One that cannot run a server says why and changes
// nothing for another.
//
// What a person sees of it is a status in words (`status`), which Settings ›
// Machines shows beside the distribution, and the reason a chat could not
// start when it could not.
//
// Lifetime:
// - `connect` starts the server, or reuses the running one. The starter's
//   stdin is the lease: a ping every fifteen seconds while it runs, each one
//   a probe. A server that leaves three in a row unanswered is hung, and is
//   stopped with what it runs; a PC waking from sleep gets a minute first.
// - After `idleMs` (ten minutes) with no call, no chat working there and no
//   work of its own (a schedule to run, a pull request watch, a message kept
//   to send: core/background-work.ts), the server is drained and stopped, so
//   the VM can idle (decision R36).
// - The desktop holds one owner connection to each server, on its `studio`
//   door (design-wsl-ssh-direct PR 3), as it does to an SSH machine's: it
//   pings the server every ten seconds and is lost after two unanswered. The
//   idle check and the quit question ask it `environment.work`.
// - An owner connection or a wire that closes is reconnected only once the
//   server has answered a lease ping: a server that died closes them a moment
//   before `wsl.exe` says it exited, and a reconnect meanwhile would read the
//   dead server as a loopback door that does not work.
// - A server that exits on its own is told apart by asking WSL: a
//   distribution now `Stopped` was shut down on purpose (`wsl --shutdown`,
//   `wsl --terminate`), and nothing starts it again until the person acts;
//   one still running crashed, and the next call restarts it after a backoff
//   that grows with each crash in a row.
// - Quitting drains every server for up to ten seconds, then lets the leases go.

export type WslServerTransport = 'loopback' | 'stdio'
export type WslServerState = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'shut-down'

export type WslServerStatus = {
  distro: string
  state: WslServerState
  /** How the Windows side reaches it, while it is ready. */
  transport?: WslServerTransport
  /** Why that transport, in words ("loopback did not answer"). */
  transportReason?: string
  /** Why it is unavailable or shut down, in words a person can act on. */
  reason?: string
  environmentId?: string
}

/** One distribution's server as the desktop holds it: its owner connection and its doors. */
export type WslServerConnection = {
  distro: string
  /**
   * The desktop's owner connection to the server's Studio, on its `studio`
   * door. It does not reconnect: its end is the server lost, and the manager
   * makes the next one.
   */
  owner: StudioClient
  /** Where the distribution mounts Windows drives; null when automount is off. */
  driveMountRoot: string | null
  environmentId: string
  /**
   * The Unix socket a WSL terminal agent's hooks report to in the
   * distribution, relayed back on the `agent-state` purpose; null when it did
   * not open there.
   */
  agentStateSocket: string | null
  /**
   * The server's data directory in the distribution, where its gateway writes
   * the discovery file an agent's MCP bridge there reads.
   */
  dataDir: string
  /**
   * What a WSL terminal of this desktop's names inside the distribution: the
   * server's Node, its resources (the hooks and the MCP bridge), the private
   * directory launch files are written into and the one each shell records its
   * pid in. The directories are null where the server could not make them.
   */
  terminals: { nodePath: string; resourcesDir: string; sessionDir: string | null; pidDir: string | null }
  /** A fresh, admitted connection for `purpose` (the shell role's Studio connection). */
  open(purpose: FrontDoorPurpose): Promise<Duplex>
}

export type WslEnvironmentManagerDeps = {
  runner: WslRunner
  listDistros(options: { force: boolean }): Promise<WslListing>
  app: { version: string; buildStamp: string; channel: 'latest' | 'nightly' }
  /** The Windows profile's id; `isDefault` for the installed app's own profile (`data/`, decision R68). */
  profile: { id: string; isDefault: boolean }
  /** The server tree this build ships, packed; null when it shipped none. */
  payload(): StreamedPayload | null
  /**
   * The build identity in that tree's `build.json`, which the server's `boot`
   * must repeat. Null (a tree from before the file) skips the check; the
   * launch script's digest check still stands.
   */
  treeBuild?(): { builtAt: string } | null
  /** The pinned Node's digests, any of which an installed Node's marker may hold. */
  nodeDigests(): string[]
  installNode(distro: string, report: NeedReport): Promise<void>
  install(
    distro: string,
    input: { kind: 'server'; digest: string; argv: (id: string) => string[]; body: () => Readable },
  ): Promise<void>
  /** `auto` tries loopback first; `stdio` always uses the bridge (`ExecutionHostSettings.serverTransport`). */
  transportFor(distro: string): 'auto' | 'stdio'
  onStatus?(status: WslServerStatus): void
  /** A new connection to a distribution's server (a start, a reconnect), for whoever follows its events. */
  onConnected?(connection: WslServerConnection): void
  log?(message: string): void
  idleMs?: number
  pingMs?: number
  /** How long the owner connection waits quiet before it pings, and for the answer (ten seconds each). */
  ownerPingMs?: number
  now?: () => number
  /** Overrides for the start's deadlines (tests). */
  start?: Partial<Pick<WslServerStartDeps, 'bootTimeoutMs' | 'readyTimeoutMs' | 'maxAttempts' | 'sleep'>>
}

export type WslEnvironmentManager = {
  /** The distribution's server, started if it is not running. Throws a `WslSetupError` in words. */
  connect(distro: string): Promise<WslServerConnection>
  /** The running connection, or null; never starts anything. */
  current(distro: string): WslServerConnection | null
  status(distro: string): WslServerStatus
  statuses(): WslServerStatus[]
  /** Something used this distribution's chats: the idle clock starts again. */
  touch(distro: string): void
  /**
   * A WSL terminal of this desktop's runs in the distribution: its agent
   * reports, and reaches Studio's tools, through the server, so the server is
   * started, never stopped for being idle while any hold stands, and started
   * again after a crash. Keyed, so a second hold under one key is harmless.
   */
  hold(distro: string, key: string): void
  /** That terminal ended: the idle clock runs again once the last hold goes. */
  release(distro: string, key: string): void
  /**
   * What each running server does on its own (schedules, watches, messages
   * kept to send), which stops with it: what the quit question names. A
   * server that does not answer within `budgetMs` is left out.
   */
  backgroundWork(options?: { budgetMs?: number }): Promise<Array<{ distro: string; work: BackgroundWork }>>
  /** Drain and stop one server (a setting moved), or all of them (quit). */
  stop(distro: string, options?: { budgetMs?: number }): Promise<void>
  shutdown(options?: { budgetMs?: number }): Promise<void>
}

const DEFAULT_IDLE_MS = 10 * 60_000
const DEFAULT_PING_MS = 15_000
const QUIT_DRAIN_MS = 10_000
const CRASH_BACKOFF_BASE_MS = 2_000
const CRASH_BACKOFF_MAX_MS = 30_000
// A server that ran this long before it crashed was healthy: its crash starts
// the backoff again from the bottom, rather than counting as one in a row.
const HEALTHY_RUN_MS = 5 * 60_000
// How long a server whose connection closed has for each lease ping before it
// is taken for hung (`answersAgain`), and stopped with every chat it runs. A dead one is known sooner,
// by its exit, so this is only ever waited out by a server that is alive but
// slow: busy, or in a VM still waking from sleep. About what a reconnect had
// before it was asked to ping first (the loopback deadline and the handshake's).
const ALIVE_PROBE_MS = 15_000
// Each lease ping is a probe: a server that leaves this many in a row
// unanswered is hung (alive, its event loop stuck), and is stopped with what
// it runs, as the desktop's own server is by its supervisor. A PC that slept
// gives its VM this long to wake before a miss counts.
const MISSED_PROBES_TO_KILL = 3
const WAKE_GRACE_MS = 60_000
// How long a message sent while a hung server is being stopped waits for it to
// exit before it is told to try again: `wsl.exe` killed says so promptly.
const HUNG_EXIT_WAIT_MS = 15_000

/** The refusal a WSL 1 distribution gets (decision R70). */
export function wsl1Refusal(distro: string): string {
  return (
    `WSL: ${distro} runs on WSL 1, and chats there need WSL 2. ` +
    `Convert it with "wsl --set-version ${distro} 2" in a Windows terminal, then try again.`
  )
}

type Handle = {
  distro: string
  status: WslServerStatus
  server: RunningWslServer | null
  connection: WslServerConnection | null
  starting: Promise<WslServerConnection> | null
  /** The background reconnect after a lost wire, while it is `starting`. */
  reconnecting: Promise<WslServerConnection> | null
  token: string | null
  crashes: number
  retryAt: number
  /** When the running server's start succeeded, for telling a crash in a row from one after a healthy run. */
  startedAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  /** The running server's lease probes: whether one is out, how many in a row went unanswered, and when the last went out. */
  probe: { inFlight: boolean; missed: number; lastAt: number; graceUntil: number }
  /** Why this app stopped the running server itself (it hung), said once its exit comes. */
  killedFor: string | null
  /** The last server's pid in the distribution, for a start that finds it still holding the data directory. */
  lastPid: number | null
  stopping: boolean
  /**
   * The word `wsl.exe --list --verbose` gave the distribution's state while
   * its server ran ("Running", or the same in the PC's language): a state
   * other than it after the server exits is a distribution WSL stopped.
   */
  runningState: string | null
  /** The WSL terminals holding this server up (`hold`), by key. */
  holds: Set<string>
  /** A restart after a crash while held, waiting out the backoff. */
  restartTimer: ReturnType<typeof setTimeout> | null
}

/** How long a WSL server is given to say what it does on its own. */
const BACKGROUND_WORK_ASK_MS = 2_000
const OWNER_PING_MS = 10_000
const OWNER_HELLO_MS = 15_000

/** What stopping a server would end, as it says (`environment.work`). */
type ServerWork = { working: boolean; work: BackgroundWork }

/**
 * What a WSL server is doing, asked over the owner connection
 * (`environment.work`). One that fails to answer has nothing to say, and is
 * read as idle (a server with no owner connection is reconnected or stopped
 * by the lease); one that does not answer in time is `no-answer`, which the
 * idle clock reads as busy: a slow server is not stopped under its
 * schedules, and a hung one is the lease's pings to stop.
 */
function askWork(owner: Pick<StudioClient, 'request'>, budgetMs: number): Promise<ServerWork | null | 'no-answer'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve()
      .then(() => owner.request('environment.work', {}))
      .then((answer) => {
        const work = parseBackgroundWork(answer)
        return work ? { working: answer.working === true, work } : null
      })
      .catch(() => null),
    new Promise<'no-answer'>((resolve) => {
      timer = setTimeout(() => resolve('no-answer'), budgetMs)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/** A connection let go: its owner connection. */
function closeConnection(connection: WslServerConnection | null | undefined): void {
  connection?.owner.close()
}

export function createWslEnvironmentManager(deps: WslEnvironmentManagerDeps): WslEnvironmentManager {
  const now = deps.now ?? Date.now
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS
  const pingMs = deps.pingMs ?? DEFAULT_PING_MS
  const log = deps.log ?? (() => undefined)
  const handles = new Map<string, Handle>()

  const handleOf = (distro: string): Handle => {
    let handle = handles.get(distro)
    if (!handle) {
      handle = {
        distro,
        status: { distro, state: 'stopped' },
        server: null,
        connection: null,
        starting: null,
        reconnecting: null,
        token: null,
        crashes: 0,
        retryAt: 0,
        startedAt: 0,
        idleTimer: null,
        pingTimer: null,
        probe: { inFlight: false, missed: 0, lastAt: 0, graceUntil: 0 },
        killedFor: null,
        lastPid: null,
        stopping: false,
        runningState: null,
        holds: new Set(),
        restartTimer: null,
      }
      handles.set(distro, handle)
    }
    return handle
  }

  const setStatus = (handle: Handle, status: Omit<WslServerStatus, 'distro'>): void => {
    handle.status = { distro: handle.distro, ...status }
    try {
      deps.onStatus?.(handle.status)
    } catch {
      // A listener's failure is its own.
    }
  }

  const clearTimers = (handle: Handle): void => {
    if (handle.idleTimer) clearTimeout(handle.idleTimer)
    if (handle.pingTimer) clearInterval(handle.pingTimer)
    handle.idleTimer = null
    handle.pingTimer = null
  }

  // A server whose connection is being reconnected, or that is still
  // starting, cannot say what it is doing: it is taken as working, not idle.
  // Otherwise a chat working holds the lease, and so does work it does on its
  // own; a server that cannot say has none, and one too slow to say is busy.
  const busy = async (handle: Handle): Promise<boolean> => {
    if (handle.holds.size > 0) return true
    const connection = handle.connection
    if (!connection || handle.starting !== null) return true
    const answer = await askWork(connection.owner, BACKGROUND_WORK_ASK_MS)
    if (answer === 'no-answer') return true
    return answer !== null && (answer.working || hasBackgroundWork(answer.work))
  }

  const armIdle = (handle: Handle): void => {
    if (handle.idleTimer) clearTimeout(handle.idleTimer)
    handle.idleTimer = setTimeout(() => {
      handle.idleTimer = null
      if (!handle.server) return
      void busy(handle).then((working) => {
        // Used meanwhile (the clock started again), or gone: nothing to do.
        if (!handle.server || handle.idleTimer) return
        if (working) {
          armIdle(handle)
          return
        }
        log(
          `Stopping the Studio server in ${handle.distro}: nothing has used it for ${Math.round(idleMs / 60_000)} minutes.`,
        )
        void stopHandle(handle, { budgetMs: QUIT_DRAIN_MS, idle: true })
      })
    }, idleMs)
    handle.idleTimer.unref?.()
  }

  /**
   * Stop a server that no longer answers, with the reason a person reads once
   * it has exited. Its wire is let go at once, and a reconnect in flight is
   * dropped: until `wsl.exe` says it exited (a moment, or longer) the next
   * message would otherwise be handed the hung server, and go nowhere.
   */
  const stopAsHung = (handle: Handle, server: RunningWslServer, reason: string): void => {
    if (handle.server !== server) return
    handle.killedFor = reason
    if (handle.reconnecting && handle.starting === handle.reconnecting) handle.starting = null
    handle.reconnecting = null
    const connection = handle.connection
    handle.connection = null
    closeConnection(connection)
    setStatus(handle, { state: 'unavailable', reason })
    server.kill()
  }

  /** Resolves once a server stopped for not answering has exited; one that has not within the bound is said to be still stopping. */
  const exitOfHung = (handle: Handle, server: RunningWslServer): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new WslSetupError(
              `The Studio server in ${handle.distro} that stopped answering is still being stopped; try again in a moment.`,
              { fatal: false, code: 'start' },
            ),
          ),
        HUNG_EXIT_WAIT_MS,
      )
      timer.unref?.()
      server.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })

  /** One lease ping, answered or not: misses in a row past the bound are a hung server. */
  async function probe(handle: Handle, server: RunningWslServer): Promise<void> {
    const state = handle.probe
    if (handle.server !== server || handle.stopping || state.inFlight) return
    const at = now()
    // A tick far behind the interval is a PC that slept: its VM wakes slowly.
    if (state.lastAt > 0 && at - state.lastAt > pingMs * 3) {
      state.missed = 0
      state.graceUntil = at + WAKE_GRACE_MS
    }
    state.lastAt = at
    state.inFlight = true
    let answered: boolean
    try {
      answered = await server.alive(pingMs)
    } finally {
      state.inFlight = false
    }
    if (handle.server !== server || handle.stopping || server.exited()) return
    if (answered) {
      state.missed = 0
      return
    }
    if (now() < state.graceUntil) return
    state.missed++
    if (state.missed < MISSED_PROBES_TO_KILL) return
    log(`The Studio server in ${handle.distro} missed ${state.missed} pings in a row; stopping it.`)
    stopAsHung(
      handle,
      server,
      `The Studio server in ${handle.distro} stopped answering, so it was stopped. It starts again with the next message.`,
    )
  }

  async function checkDistro(distro: string): Promise<void> {
    const listing = await deps.listDistros({ force: false })
    if (!listing.distros) {
      throw new WslSetupError(
        'Couldn\'t set up WSL: WSL is not installed on this PC, or it did not answer. Install it with "wsl --install".',
        { fatal: true, code: 'wsl-missing' },
      )
    }
    const listed = listing.distros.find((entry) => entry.name === distro)
    if (!listed) {
      const fresh = await deps.listDistros({ force: true })
      if (!fresh.distros?.some((entry) => entry.name === distro))
        throw new WslSetupError(`Couldn't set up WSL: ${distro} is not installed on this PC.`, {
          fatal: true,
          code: 'distro-missing',
        })
      return checkDistro(distro)
    }
    if (listed.version === 1) throw new WslSetupError(wsl1Refusal(distro), { fatal: true, code: 'start' })
  }

  function envelopeFor(
    handle: Handle,
    token: string,
    boot: Parameters<WslServerStartDeps['envelopeFor']>[0],
  ): ServerBootstrapEnvelope {
    const paths = wslServerPaths(boot.home, deps.profile)
    const appDir = boot.appDir.replace(/\/+$/u, '')
    if (!appDir.endsWith(`/${serverTreeName(deps.app.version)}`))
      throw new Error(`it runs from ${appDir}, not this app version's server tree.`)
    // The envelope's build stamp is empty (the desktop's own stamp is not the
    // tree's), so the build is checked here instead: the launch script's digest
    // check and its exec are not one step, and another copy of the app of the
    // same version can replace the tree in between. Not fatal: the next
    // attempt's launch script sees the other digest and installs this one.
    const expected = deps.treeBuild?.() ?? null
    if (expected && boot.builtAt !== expected.builtAt)
      throw new WslSetupError(
        `The Studio server in ${handle.distro} is another build of version ${deps.app.version} (built ${boot.builtAt ?? 'at an unknown time'}, not ${expected.builtAt}); another copy of the app installed it. This build's server is installed again.`,
        { fatal: false, code: 'start' },
      )
    return {
      v: 1,
      role: 'headless',
      dataDir: paths.dataDir,
      logsDir: paths.logsDir,
      runDir: paths.runDir,
      tempDir: paths.tempDir,
      paths: {
        resourcesDir: `${appDir}/resources`,
        appPath: appDir,
        isPackaged: true,
        appExecPath: boot.execPath,
      },
      app: deps.app,
      owner: { tokenHash: ownerTokenHash(token) },
      listeners: {
        gateway: true,
        tailnet: 'off',
        frontDoor: { loopback: deps.transportFor(handle.distro) !== 'stdio' },
      },
      secrets: { kind: 'key-file' },
      flags: {},
      wsl: { distro: handle.distro, profile: deps.profile.id },
    }
  }

  /** An admitted stream for `purpose`: loopback first when allowed, the bridge when it fails or is forced. */
  async function openDoor(
    handle: Handle,
    purpose: FrontDoorPurpose,
  ): Promise<{ stream: Duplex; transport: WslServerTransport; reason: string }> {
    const server = handle.server
    const token = handle.token
    if (!server || !token) throw new Error(`The Studio server in ${handle.distro} is not running.`)
    const door = server.ready.frontDoor
    if (!door) throw new Error(`The Studio server in ${handle.distro} opened no front door.`)
    let reason = 'the bridge is chosen in Settings'
    if (deps.transportFor(handle.distro) !== 'stdio') {
      if (door.port === null) reason = 'the loopback door did not open in the distribution'
      else {
        try {
          const socket = await connectLoopback(door.port)
          return {
            stream: await enterFrontDoor(socket, { token, purpose }),
            transport: 'loopback',
            reason: 'loopback answered',
          }
        } catch (error) {
          // A server that died under the attempt says nothing about loopback.
          if (handle.server !== server || server.exited())
            throw new Error(`The Studio server in ${handle.distro} stopped.`)
          // A squatter's decoy fails the proof here, and gets nothing.
          reason = `loopback did not work (${error instanceof Error ? error.message : String(error)})`
          log(`The Studio server in ${handle.distro}: ${reason}; using the stdio bridge.`)
        }
      }
    }
    if (!door.socketPath) throw new Error(`The Studio server in ${handle.distro} has no bridge socket, and ${reason}.`)
    const bridged = await openBridge(
      () => deps.runner.spawnShell(handle.distro),
      buildBridgeScript(deps.app.version),
      door.socketPath,
    )
    return { stream: await enterFrontDoor(bridged, { token, purpose }), transport: 'stdio', reason }
  }

  /**
   * Whether a server whose connection was lost still answers its lease: as
   * many tries as the lease's own probes allow before it is taken for hung,
   * and more while a PC that slept gives its VM time to wake. An owner
   * connection's ten-second ping is quicker than either, so its end alone
   * never stops a server that is only slow.
   */
  async function answersAgain(handle: Handle, server: RunningWslServer): Promise<boolean> {
    for (let missed = 0; ;) {
      if (await server.alive(ALIVE_PROBE_MS)) return true
      if (server.exited() || handle.server !== server) return false
      if (now() < handle.probe.graceUntil) continue
      if (++missed >= MISSED_PROBES_TO_KILL) return false
    }
  }

  /**
   * The desktop's owner connection to the server's Studio, over its `studio`
   * door: the front door hands the stream a one-use shell ticket, the client
   * says hello with it. It pings the server when quiet and ends when an
   * answer does not come; it never reconnects on its own.
   */
  async function openOwner(
    handle: Handle,
  ): Promise<{ owner: StudioClient; transport: WslServerTransport; reason: string }> {
    let opened: { transport: WslServerTransport; reason: string } | null = null
    const owner = await connectStudio({
      transport: async () => {
        const door = await openDoor(handle, 'studio')
        opened = { transport: door.transport, reason: door.reason }
        return lineTransport(door.stream, await readTicket(door.stream, OWNER_HELLO_MS))
      },
      client: { name: 'SprintEngine Studio', kind: 'desktop' },
      reconnect: false,
      // No read deadline of the client's own: a git write with hooks runs as
      // long as it runs, and each caller here bounds what it waits for.
      readTimeoutMs: 0,
      helloTimeoutMs: OWNER_HELLO_MS,
      heartbeat: { intervalMs: deps.ownerPingMs ?? OWNER_PING_MS, timeoutMs: deps.ownerPingMs ?? OWNER_PING_MS },
    })
    const how = opened as { transport: WslServerTransport; reason: string } | null
    return { owner, transport: how?.transport ?? 'stdio', reason: how?.reason ?? '' }
  }

  async function connectOwner(handle: Handle): Promise<WslServerConnection> {
    const server = handle.server!
    const { owner, transport, reason } = await openOwner(handle)
    const connection: WslServerConnection = {
      distro: handle.distro,
      owner,
      driveMountRoot: server.ready.frontDoor?.driveMountRoot ?? null,
      environmentId: server.ready.environmentId,
      agentStateSocket: server.ready.frontDoor?.agentStateSocket ?? null,
      dataDir: wslServerPaths(server.boot.home, deps.profile).dataDir,
      terminals: {
        nodePath: server.boot.execPath,
        resourcesDir: `${server.boot.appDir.replace(/\/+$/u, '')}/resources`,
        sessionDir: server.ready.frontDoor?.sessionDir ?? null,
        pidDir: server.ready.frontDoor?.pidDir ?? null,
      },
      open: async (purpose) => (await openDoor(handle, purpose)).stream,
    }
    // Lost when the owner connection ends: closed, or a ping unanswered.
    const lost = (why: string) => {
      if (handle.connection !== connection) return
      handle.connection = null
      closeConnection(connection)
      if (handle.stopping || !handle.server || handle.killedFor !== null) return
      // If the server is still there, one reconnect, then the server is
      // stopped and the next call starts it afresh. If it died, its exit (a
      // moment behind the connection) says so, and nothing is reconnected.
      log(`The connection to the Studio server in ${handle.distro} closed (${why}).`)
      const reconnect = async (): Promise<WslServerConnection> => {
        const alive = await answersAgain(handle, server)
        if (server.exited() || handle.server !== server)
          throw new Error(`The Studio server in ${handle.distro} stopped.`)
        if (!alive) throw new Error('the server did not answer a ping.')
        log(`The Studio server in ${handle.distro} is still running; reconnecting.`)
        return connectOwner(handle)
      }
      // Held as the start in progress, so a call meanwhile waits for this
      // reconnect instead of opening a second connection beside it.
      const reconnecting = (handle.starting ??= reconnect().finally(() => {
        if (handle.starting === reconnecting) handle.starting = null
        if (handle.reconnecting === reconnecting) handle.reconnecting = null
      }))
      handle.reconnecting = reconnecting
      void reconnecting.then(
        () => undefined,
        (error: unknown) => {
          // The server itself went meanwhile: its exit says why.
          if (handle.server !== server || server.exited()) return
          stopAsHung(
            handle,
            server,
            `The connection to the Studio server in ${handle.distro} was lost: ${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
    }
    void owner.closed.then(
      () => lost('its Studio connection ended'),
      (error: unknown) =>
        lost(`its Studio connection ended: ${error instanceof Error ? error.message : String(error)}`),
    )
    handle.connection = connection
    setStatus(handle, {
      state: 'ready',
      transport,
      transportReason: reason,
      environmentId: server.ready.environmentId,
    })
    try {
      deps.onConnected?.(connection)
    } catch (error) {
      log(`A WSL server listener threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    return connection
  }

  async function onServerExit(handle: Handle, server: RunningWslServer, exit: WslServerExit): Promise<void> {
    if (handle.server !== server) return
    handle.server = null
    handle.token = null
    // A wire lost because the server died is not reconnected: the next call
    // starts a server (or is told when it will), not waits on a dead one.
    if (handle.reconnecting && handle.starting === handle.reconnecting) handle.starting = null
    handle.reconnecting = null
    const connection = handle.connection
    handle.connection = null
    clearTimers(handle)
    closeConnection(connection)
    const killedFor = handle.killedFor
    handle.killedFor = null
    // Stopped here for not answering: that is what is said, not "stopped".
    if (killedFor !== null) {
      setStatus(handle, { state: 'unavailable', reason: killedFor })
      return
    }
    if (exit.intentional || handle.stopping) {
      setStatus(handle, { state: 'stopped' })
      return
    }
    // Every Linux process dies at once on `wsl --shutdown`; WSL then lists
    // the distribution as stopped. That is the person's doing, and is left be.
    // The listing is in the PC's language, so "stopped" is any state but the
    // one it was listed in while the server ran; English where that is unknown.
    const listing = await deps.listDistros({ force: true }).catch(() => null)
    // A message sent while WSL was being listed started a server again: what
    // is said now would be about that one, and would end the turns it runs.
    if (handle.server || handle.starting || handle.stopping) return
    const state = listing?.distros?.find((entry) => entry.name === handle.distro)?.state
    if (state && (handle.runningState ? state !== handle.runningState : /^stopped$/iu.test(state))) {
      setStatus(handle, {
        state: 'shut-down',
        reason: `WSL was shut down, so the Studio server in ${handle.distro} stopped. It starts again with the next message.`,
      })
      return
    }
    if (now() - handle.startedAt >= HEALTHY_RUN_MS) handle.crashes = 0
    handle.crashes++
    const wait =
      backoffDelayMs(handle.crashes - 1, { baseMs: CRASH_BACKOFF_BASE_MS, maxMs: CRASH_BACKOFF_MAX_MS }) ??
      CRASH_BACKOFF_MAX_MS
    handle.retryAt = now() + wait
    // Why, as the exit says it: what the server printed while it worked
    // (a library's warnings) is not why it stopped.
    const how = describeServerExit(exit)
    setStatus(handle, {
      state: 'unavailable',
      reason: `The Studio server in ${handle.distro} stopped unexpectedly (${how}). It starts again with the next message.`,
    })
    log(`The Studio server in ${handle.distro} stopped unexpectedly (${how}).`)
    restartIfHeld(handle, wait)
  }

  // A held server (a WSL terminal runs there) does not wait for the next
  // message to start again: its agent's reports and tools go through it.
  function restartIfHeld(handle: Handle, wait: number): void {
    if (handle.holds.size === 0 || handle.restartTimer) return
    handle.restartTimer = setTimeout(() => {
      handle.restartTimer = null
      if (handle.holds.size === 0 || handle.server || handle.starting) return
      // The timer has waited the backoff out. `retryAt` is on the app's clock,
      // which can read behind the timers' (a Node timer fires up to a
      // millisecond before `Date.now()` reaches its end, and the wall clock
      // can be set back): read against it, the start would be turned away as
      // too soon, and nothing would try again.
      handle.retryAt = Math.min(handle.retryAt, now())
      void connect(handle.distro).catch((error: unknown) =>
        log(
          `The Studio server in ${handle.distro} did not start again for its WSL terminals: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }, wait)
    handle.restartTimer.unref?.()
  }

  async function start(handle: Handle): Promise<WslServerConnection> {
    if (handle.retryAt > now()) {
      throw new WslSetupError(
        `The Studio server in ${handle.distro} stopped a moment ago; it is tried again in ${Math.ceil((handle.retryAt - now()) / 1000)} s.`,
        { fatal: false, code: 'start' },
      )
    }
    setStatus(handle, { state: 'starting', reason: `Starting WSL: ${handle.distro}…` })
    try {
      await checkDistro(handle.distro)
      const payload = deps.payload()
      if (!payload)
        throw new WslSetupError(
          "Couldn't set up WSL: this build shipped without the Studio server for WSL (run npm run build:server:wsl in a checkout).",
          { fatal: true, code: 'install' },
        )
      const token = `seown_${randomBytes(32).toString('base64url')}`
      handle.token = token
      const server = await startWslServer({
        distro: handle.distro,
        spawnShell: () => deps.runner.spawnShell(handle.distro),
        launchScript: async () =>
          buildLaunchScript({
            appVersion: deps.app.version,
            nodeDigests: deps.nodeDigests(),
            appDigest: payload.digest,
          }),
        install: async (report) => {
          if (report.node) await deps.installNode(handle.distro, report)
          if (report.app)
            await deps.install(handle.distro, {
              kind: 'server',
              digest: payload.digest,
              argv: (id) => tarArgs('app', id),
              body: () => payload.body(),
            })
        },
        prewarm: async () => {
          await deps.runner.runScript(handle.distro, 'true', { timeoutMs: 60_000 })
        },
        envelopeFor: (boot) => envelopeFor(handle, token, boot),
        killInDistro: async (pid) => {
          if (!Number.isSafeInteger(pid) || pid <= 1) return
          await deps.runner.runScript(handle.distro, `kill -9 ${pid} 2>/dev/null; true`, { timeoutMs: 15_000 })
        },
        lockHolder: async (runDir) => {
          if (/['\0\n]/u.test(runDir)) return null
          const read = await deps.runner.runScript(
            handle.distro,
            `head -c 1024 '${runDir}/studio.lock' 2>/dev/null; true`,
            {
              timeoutMs: 15_000,
            },
          )
          const pid = /"pid"\s*:\s*(\d+)/u.exec(read.stdout)?.[1]
          return pid ? Number(pid) : null
        },
        previousPid: handle.lastPid,
        log,
        ...deps.start,
      })
      handle.server = server
      handle.lastPid = server.boot.pid
      server.onExit((exit) => void onServerExit(handle, server, exit))
      handle.killedFor = null
      handle.probe = { inFlight: false, missed: 0, lastAt: 0, graceUntil: 0 }
      handle.pingTimer = setInterval(() => void probe(handle, server), pingMs)
      handle.pingTimer.unref?.()
      const connection = await connectOwner(handle)
      // Not a reset of the crash count: a server that crashes again soon after
      // starting is the next crash in a row, and waits longer.
      handle.startedAt = now()
      armIdle(handle)
      // What WSL calls a running distribution, in this PC's language, read
      // while this one surely runs; listing does not start the VM.
      void deps
        .listDistros({ force: true })
        .then((listed) => {
          const running = listed.distros?.find((entry) => entry.name === handle.distro)?.state
          if (running && handle.server === server) handle.runningState = running
        })
        .catch(() => undefined)
      return connection
    } catch (error) {
      const failure =
        error instanceof WslSetupError
          ? error
          : new WslSetupError(
              `The Studio server in ${handle.distro} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
              { fatal: false, code: 'start' },
            )
      const server = handle.server
      handle.server = null
      handle.token = null
      clearTimers(handle)
      server?.kill()
      setStatus(handle, { state: 'unavailable', reason: failure.message })
      throw failure
    }
  }

  async function stopHandle(handle: Handle, options: { budgetMs?: number; idle?: boolean } = {}): Promise<void> {
    await handle.starting?.catch(() => undefined)
    const server = handle.server
    if (!server) return
    // An idle stop that waited for a start or a reconnect looks again: the
    // server may have been used meanwhile, or a chat begun working there.
    if (options.idle) {
      if (handle.idleTimer) return
      const working = await busy(handle)
      if (handle.idleTimer || handle.server !== server || handle.stopping) return
      if (working) {
        armIdle(handle)
        return
      }
    }
    handle.stopping = true
    clearTimers(handle)
    try {
      await server.stop({ drain: true, budgetMs: options.budgetMs ?? QUIT_DRAIN_MS })
    } finally {
      handle.stopping = false
      if (handle.server === server) {
        handle.server = null
        closeConnection(handle.connection)
        handle.connection = null
        handle.token = null
        setStatus(handle, { state: 'stopped' })
      }
    }
  }

  function connect(distro: string): Promise<WslServerConnection> {
    const handle = handleOf(distro)
    // A server stopped for not answering is neither handed out nor
    // reconnected to while it goes: the next server starts once it has.
    const hung = handle.killedFor !== null ? handle.server : null
    if (hung) {
      handle.starting ??= exitOfHung(handle, hung)
        .then(() => (handle.server ? connectOwner(handle) : start(handle)))
        .finally(() => {
          handle.starting = null
        })
      return handle.starting
    }
    if (handle.connection && handle.server) {
      // An owner connection that has just ended is not handed out: once its
      // end is heard, the reconnect it starts is.
      const owner = handle.connection.owner
      if (owner.state === 'closed')
        return owner.closed.then(
          () => connect(distro),
          () => connect(distro),
        )
      armIdle(handle)
      return Promise.resolve(handle.connection)
    }
    handle.starting ??= (handle.server ? connectOwner(handle) : start(handle)).finally(() => {
      handle.starting = null
    })
    return handle.starting
  }

  return {
    connect,
    current: (distro) => {
      const handle = handles.get(distro)
      return handle?.server ? handle.connection : null
    },
    status: (distro) => handles.get(distro)?.status ?? { distro, state: 'stopped' },
    async backgroundWork(options = {}) {
      const budgetMs = options.budgetMs ?? BACKGROUND_WORK_ASK_MS
      const asked = [...handles.entries()].flatMap(([distro, handle]) => {
        const connection = handle.connection
        if (!connection || !handle.server) return []
        return [
          askWork(connection.owner, budgetMs).then((answer) =>
            answer && answer !== 'no-answer' ? [{ distro, work: answer.work }] : [],
          ),
        ]
      })
      return (await Promise.all(asked)).flat()
    },
    statuses: () => [...handles.values()].map((handle) => handle.status),
    touch(distro) {
      const handle = handles.get(distro)
      if (handle?.server) armIdle(handle)
    },
    hold(distro, key) {
      const handle = handleOf(distro)
      handle.holds.add(key)
      // Started now, so the terminal's agent finds the socket it reports to.
      if (!handle.server && !handle.starting && handle.retryAt <= now()) void connect(distro).catch(() => undefined)
      else if (!handle.server) restartIfHeld(handle, Math.max(0, handle.retryAt - now()))
    },
    release(distro, key) {
      const handle = handles.get(distro)
      if (!handle?.holds.delete(key) || handle.holds.size > 0) return
      if (handle.restartTimer) clearTimeout(handle.restartTimer)
      handle.restartTimer = null
      if (handle.server) armIdle(handle)
    },
    stop: (distro, options) => {
      const handle = handles.get(distro)
      return handle ? stopHandle(handle, options) : Promise.resolve()
    },
    async shutdown(options = {}) {
      for (const handle of handles.values()) {
        if (handle.restartTimer) clearTimeout(handle.restartTimer)
        handle.restartTimer = null
        handle.holds.clear()
      }
      await Promise.all([...handles.values()].map((handle) => stopHandle(handle, options).catch(() => undefined)))
    },
  }
}
