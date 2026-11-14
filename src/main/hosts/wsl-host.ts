// One WSL distribution, as a machine of its own ("WSL: Ubuntu").
//
// What this host answers comes from two places inside the distribution, while
// the WSL helper is being retired (design-wsl-ssh-direct PR 4):
//   - the distribution's own Studio server, which this desktop's core starts
//     and holds (`WslDistributionLink`): the socket a terminal agent's hooks
//     report to, relayed back to this PC; a WSL terminal holds that server up;
//   - the helper (`resources/wsl-helper/`), over the one `wsl.exe` stdio
//     channel its client holds (`wsl-helper-client.ts`), for the rest: process
//     reads for the reaper, the survivor kill, CLI detection, the home folder,
//     running a program, and git.
// Anything that needs the host starts the helper first if it is stopped, and a
// launch waits for that. There is no second path: when the helper cannot
// start, the host says why (`WslSetupError`) and the launch fails with that
// reason.
//
// The one thing not run by the helper is the terminal itself: its pty is
// `wsl.exe -d <distro> -e bash -li <startup script>` (terminal-launch),
// because that is what gives the agent a real terminal. The helper writes that
// script into its private directory inside the distribution first
// (`writeLaunchFiles`), so it is run from a Linux path and never read through a
// `/mnt/<drive>` mount. It carries the agent's identity, the agent-state
// socket and the launch's MCP channel token as `export` lines.

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { CliDetectResult, CliRuntimeSettings } from '../../shared/electron-api'
import {
  executionHostLabel,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostState,
  type ExecutionHostSummary,
} from '../../shared/execution-host'
import { isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'
import { MCP_CHANNEL_TOKEN_ENV } from '../../shared/studio-env'
import { cliProbeRequest, detectResultFromHelper, type HelperProbeAnswer } from '../cli-runtime-install'
import { splitSubcommand } from '../git-run'
import type { RunOutcome } from '../process-run'
import type { GatewayLaunchIdentity } from '../../server/core/gateway-launch-tokens'
import type {
  StudioLaunchFile,
  StudioTerminalProcessesAsk,
} from '../../../packages/studio-protocol/src/environment-access'
import type { SubtreeLiveReason } from '../terminal-subtree-probe'
import type {
  ExecutionHost,
  HostAgentIntegration,
  HostHome,
  HostProcessRef,
  HostSettingsReader,
} from './execution-host'
import { wslSessionPidKey, type WslDistro } from './wsl-distro'
import type { WslHelperClient, WslHelperInfo } from './wsl-helper-client'
import { createDefaultWslHelperClient, wslHelperEnvironment } from './wsl-helper-runtime'
import { buildWslPluginCopy, type WslPluginCopy } from './wsl-plugin-copy'
import { WslSetupError } from './wsl-setup-error'
import { WSL_DATA_REL } from './wsl-install'
import { migrateHostEntries } from '../integrations/integration-boot'
import { scanHomeIntegrations } from '../integrations/integration-scan'
import { buildLauncherMcpServer, ensureStudioLauncher, launcherRefForHome } from '../integrations/launcher'
import { integrationLedger, recordIntegrationWrite } from '../integrations/ledger'

/**
 * A git argument as Linux git reads it: a native absolute path (a worktree to
 * add, a `--git-dir=`) becomes the path in the distribution; everything else —
 * subcommands, flags, refs, relative pathspecs — is untouched.
 */
export function wslGitArg(arg: string): string {
  if (isWindowsPath(arg)) return toWslPath(arg)
  const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
  if (equals > 0 && isWindowsPath(arg.slice(equals + 1))) {
    return `${arg.slice(0, equals + 1)}${toWslPath(arg.slice(equals + 1))}`
  }
  return arg
}

/**
 * Git's answer with the absolute paths it printed put back into native form, so
 * a caller comparing `rev-parse --show-toplevel` or a worktree list against the
 * workspace folder sees the same spelling Windows git would have printed.
 * Porcelain status and diffs print paths relative to the repository and are
 * left alone.
 *
 * The subcommand is read past git's global options (`-c key=value`, `-C dir`),
 * so a `-c` value is never taken for it. With `-z` git ends each record with a
 * NUL instead of a newline (`worktree list --porcelain -z`), and the records
 * are split on that.
 */
export function nativeGitOutput(args: readonly string[], stdout: string, distro: string): string {
  const { subcommand, rest } = splitSubcommand(args)
  const separator = rest.includes('-z') ? '\0' : '\n'
  const toNative = (path: string) => wslToWindowsPath(path, { distro, separator: '/' })
  if (subcommand === 'rev-parse') {
    return stdout
      .split(separator)
      .map((line) => (line.startsWith('/') ? toNative(line) : line))
      .join(separator)
  }
  if (subcommand === 'worktree') {
    return stdout
      .split(separator)
      .map((line) => {
        if (line.startsWith('worktree /')) return `worktree ${toNative(line.slice('worktree '.length))}`
        if (separator === '\0') return line
        // The human listing: the path, then the head and the branch.
        const match = /^(\/\S*)(\s.*)?$/u.exec(line)
        return match ? `${toNative(match[1])}${match[2] ?? ''}` : line
      })
      .join(separator)
  }
  return stdout
}

/** The state a distribution's `wsl --list` row reports, as a host state. */
export function wslHostState(distro: WslDistro | undefined): { state: ExecutionHostState; reason?: string } {
  if (!distro) return { state: 'unavailable', reason: 'This distribution is not installed.' }
  const state = distro.state.toLowerCase()
  if (state === 'running') return { state: 'ready' }
  // A stopped distribution is still usable: the first process started in it
  // boots it, which takes a second or two.
  if (state === 'stopped') return { state: 'stopped' }
  return { state: 'starting', reason: `WSL reports it as ${distro.state}.` }
}

/**
 * A WSL distribution's own Studio server, as the host of this desktop's WSL
 * terminals reaches it: the core's WSL servers, in whichever process the
 * terminals run. A host with none (main's own registry, out of process) starts
 * no WSL terminal.
 */
export type WslDistributionLink = {
  /** The distribution's server, started if it is not running. Throws a `WslSetupError` in words. */
  connect(distro: string): Promise<WslDistributionFacts>
  /** A WSL terminal runs there: its server is kept up while it does. */
  hold(distro: string, key: string): void
  release(distro: string, key: string): void
  /**
   * A launch token for an agent that runs there, which that server's gateway
   * takes the agent's identity from (`wsl-launch-tokens.ts`). `sent` settles
   * once the server was told.
   */
  issueLaunchToken(distro: string, identity: GatewayLaunchIdentity): { token: string; sent: Promise<void> }
  revokeLaunchToken(distro: string, token: string): void
  /**
   * What the distribution's server does for this desktop's WSL terminals
   * (`distribution-terminal-host.ts`): on the running server, or with `start`
   * on one started for it. Null when it is not running and not to be started.
   */
  terminalHost(distro: string, options: { start: boolean }): Promise<WslTerminalHostClient | null>
}

/** The terminal host of a distribution's server, over this desktop's owner connection to it. */
export type WslTerminalHostClient = {
  launchFiles(params: { write?: StudioLaunchFile[]; remove?: string[] }): Promise<{ paths: string[] }>
  processes(
    ask: StudioTerminalProcessesAsk,
  ): Promise<{ verdicts?: Record<string, SubtreeLiveReason | null>; killed?: number[] }>
}

/** What a launch needs to know of the distribution's server. */
export type WslDistributionFacts = {
  /** The socket its terminal agents' hooks report to; null when it did not open. */
  agentStateSocket: string | null
  /** Its data directory, where its gateway's discovery file is: what the MCP bridge there reads. */
  dataDir: string
  /** Where it writes a launch's files and where each launch's shell records its pid; null where it could not. */
  sessionDir: string | null
  pidDir: string | null
}

export type WslHostDeps = {
  readSettings: HostSettingsReader
  /** The distribution's own Studio server; absent, no launch is prepared here. */
  distribution?: WslDistributionLink | null
  /** What the last `wsl --list` said about this distribution; undefined when it was not listed. */
  listed: () => WslDistro | undefined
  /** The helper client; tests pass a stand-in. Absent is the real one. */
  helper?: WslHelperClient
  /** The plugin copy for a running helper and the distribution's server; tests pass a stand-in. */
  buildPluginCopy?: (info: WslHelperInfo, server: PreparedServer) => Promise<WslPluginCopy | null>
  /** How long the survivor kill waits for a killed pty's children to go on their own. */
  survivorDelayMs?: number
  /** Writes the distribution's Studio launcher and its pointer; tests pass a stand-in. */
  ensureLauncher?: (home: HostHome, info: WslHelperInfo) => Promise<void>
}

// `electron .` (a development run) sets `defaultApp`; a packaged build does not.
function isPackagedProcess(): boolean {
  return (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp !== true
}

type HelperRunOutcome = RunOutcome & { truncated?: boolean }

// The helper enforces a deadline itself; this is how much longer main waits
// for its answer before giving up on it.
const ANSWER_SLACK_MS = 10_000
const SNAPSHOT_TIMEOUT_MS = 20_000
const DETECT_TIMEOUT_MS = 60_000
const HOME_TIMEOUT_MS = 45_000
const MAX_PREPARE_ROUNDS = 4

/** `work`'s answer, or a rejection once `ms` pass without one. */
function withDeadline<T>(work: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!work) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in time')), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function failedRun(error: unknown): RunOutcome {
  return {
    code: 1,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false,
    spawnFailed: true,
  }
}

/** The distribution's server as a launch is prepared against it. */
type PreparedServer = { agentStateSocket: string; dataDir: string; sessionDir: string; pidDir: string }

const sameServer = (a: PreparedServer, b: PreparedServer) =>
  a.agentStateSocket === b.agentStateSocket &&
  a.dataDir === b.dataDir &&
  a.sessionDir === b.sessionDir &&
  a.pidDir === b.pidDir

function defaultPluginCopy(info: WslHelperInfo, server: PreparedServer): Promise<WslPluginCopy | null> {
  const env = wslHelperEnvironment()
  if (!env) return Promise.resolve(null)
  return buildWslPluginCopy(env.pluginSources(), {
    profile: info.profile,
    nodeCommand: info.nodePath,
    appDir: info.appDir,
    userDataDir: server.dataDir,
    agentStateSocketPath: server.agentStateSocket,
  })
}

export function createWslHost(distro: string, deps: WslHostDeps): ExecutionHost {
  const id: ExecutionHostId = wslHostId(distro)
  const helper = deps.helper ?? createDefaultWslHelperClient(distro)
  const buildPluginCopy = deps.buildPluginCopy ?? defaultPluginCopy
  const survivorDelayMs = deps.survivorDelayMs ?? 2_000
  const settings = () => deps.readSettings(id)
  const toNativePath = (hostPath: string) => wslToWindowsPath(hostPath, { distro })

  // Per running helper: what `home` said, and the plugin copy it holds — for
  // the Studio skills chosen when it was made (`skills`) and the socket its
  // hooks report to (`agentStateSocket`, the distribution's server's). A skill
  // switched on or off since, or another socket, is a different copy, so the
  // next launch prepares again.
  let prepared: {
    info: WslHelperInfo
    skills: string
    server: PreparedServer
    home: HostHome
    plugin: WslPluginCopy | null
    launcherReady: boolean
  } | null = null
  // The preparation in flight, and the helper, socket and skill choice it is for.
  let preparing: { info: WslHelperInfo; skills: string; server: PreparedServer; done: Promise<void> } | null = null
  const skillChoice = (): string => (wslHelperEnvironment()?.pluginSources().enabledSkillDirs ?? []).join(',')
  const isPrepared = (info: WslHelperInfo | null, server: PreparedServer): boolean =>
    info !== null && prepared?.info === info && prepared.skills === skillChoice() && sameServer(prepared.server, server)

  async function readHome(): Promise<HostHome> {
    // The first `home` after a start waits on the login-shell read, which has
    // its own deadline inside the helper; this one is longer than that.
    const answer = await helper.request<{ home: string; env?: Record<string, string> }>('home', undefined, {
      timeoutMs: HOME_TIMEOUT_MS,
    })
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(answer.env ?? {})) {
      if (typeof value === 'string' && value.startsWith('/')) env[name] = toNativePath(value)
    }
    return { host: answer.home, native: toNativePath(answer.home), env }
  }

  // Whether the distribution's launcher is on disk: only then do the hooks and
  // the gateway written for it name the launcher. Without it they keep the
  // form that names the pinned Node, which works while this version is
  // installed — better than a launcher path that fails on every event.
  async function ensureLauncher(home: HostHome, info: WslHelperInfo): Promise<boolean> {
    if (deps.ensureLauncher) {
      await deps.ensureLauncher(home, info)
      return true
    }
    // A distribution's home only opens as an absolute `\\wsl.localhost` path on
    // Windows; anything else (a test faking the platform) is not a place to write.
    if (process.platform !== 'win32' || !isAbsolute(home.native)) return false
    const result = await ensureStudioLauncher({
      nativeHome: home.native,
      shell: 'posix',
      pointer: { node: info.nodePath, runAsNode: false, payload: info.appDir, packaged: isPackagedProcess() },
      pointerTargetExists: (pointer) => existsSync(toNativePath(pointer.node)),
    })
    recordIntegrationWrite(
      { kind: 'launcher', path: result.dir, marker: 'owned', hostId: id, createdFile: true },
      {
        kind: 'wsl-data',
        path: join(home.native, ...WSL_DATA_REL.split('/')),
        marker: 'owned',
        hostId: id,
        createdFile: true,
        detail: { hostHome: home.host },
      },
    )
    // What an earlier build wrote in this distribution: its home's hook and,
    // for every listed entry, the move onto the launcher written just above.
    // In the background: it reads files across the distribution boundary, and
    // a launch has no need to wait for it.
    const ledger = integrationLedger()
    if (ledger) {
      void (async () => {
        await ledger.record(await scanHomeIntegrations({ native: home.native, hostId: id }))
        // A bare `node` command here was written for this distribution's own
        // shell, so it moves to this distribution's launcher.
        await migrateHostEntries(ledger, id, { localLauncher: launcherRefForHome(home.host, 'posix') })
      })().catch(() => undefined)
    }
    return true
  }

  async function ensurePluginCopy(info: WslHelperInfo, server: PreparedServer): Promise<WslPluginCopy | null> {
    const copy = await buildPluginCopy(info, server).catch(() => null)
    if (!copy) return null
    const status = await helper.request<{ current: boolean }>('files.ensureTree', {
      name: copy.tree,
      digest: copy.digest,
    })
    if (!status.current) {
      await helper.request('files.ensureTree', { name: copy.tree, digest: copy.digest, files: copy.files })
    }
    return copy
  }

  function prepareFor(info: WslHelperInfo, server: PreparedServer): Promise<void> {
    const skills = skillChoice()
    if (preparing?.info === info && preparing.skills === skills && sameServer(preparing.server, server))
      return preparing.done
    const done = (async () => {
      const home = await readHome()
      // The launcher and its pointer, before anything that names them is
      // written. A failure is not the launch's: its hooks keep the older form.
      const launcherReady = await ensureLauncher(home, info).catch(() => false)
      // The copy is what lets a WSL Claude take `--plugin-dir`; without it
      // that CLI falls back to the workspace install, so a failure here is
      // not the launch's failure.
      const plugin = await ensurePluginCopy(info, server).catch(() => null)
      if (helper.info() === info) prepared = { info, skills, server, home, plugin, launcherReady }
    })()
    const entry = { info, skills, server, done }
    preparing = entry
    void done
      .finally(() => {
        if (preparing === entry) preparing = null
      })
      .catch(() => undefined)
    return done
  }

  // Resolves only once what was prepared belongs to the helper running now.
  // A helper that restarts part-way (`wsl --shutdown`, a crash) leaves a
  // preparation for one that is gone; waiting on that alone would let a
  // launch go ahead with no hooks, socket or gateway. Bounded, because a
  // helper that keeps restarting is its own failure.
  async function prepare(): Promise<void> {
    const server = await distributionServer()
    for (let round = 0; round < MAX_PREPARE_ROUNDS; round += 1) {
      const info = await helper.start()
      if (isPrepared(info, server)) return
      await prepareFor(info, server)
      if (isPrepared(helper.info(), server)) return
    }
    throw new WslSetupError(`The WSL helper for ${distro} kept restarting while it was being set up.`, {
      fatal: false,
      code: 'start',
    })
  }

  // The distribution's server, started for the launch: its agent-state
  // socket is what this launch's hooks report to, and its gateway (found in
  // its data directory) is what the launch's agent reaches Studio's tools on.
  async function distributionServer(): Promise<PreparedServer> {
    if (!deps.distribution) {
      throw new WslSetupError(
        `WSL terminals start where Studio's server runs; this process cannot start one in ${distro}.`,
        {
          fatal: true,
          code: 'start',
        },
      )
    }
    const { agentStateSocket, dataDir, sessionDir, pidDir } = await deps.distribution.connect(distro)
    if (!agentStateSocket) {
      throw new WslSetupError(
        `The Studio server in ${distro} could not open the socket its terminal agents report to, so a terminal agent there would not show what it is doing.`,
        { fatal: false, code: 'start' },
      )
    }
    if (!sessionDir || !pidDir) {
      throw new WslSetupError(
        `The Studio server in ${distro} could not make the private directory a terminal's startup script is written to, so nothing can be started there.`,
        { fatal: false, code: 'start' },
      )
    }
    return { agentStateSocket, dataDir, sessionDir, pidDir }
  }

  function integration(): HostAgentIntegration | null {
    const info = helper.info()
    if (!info || !prepared || prepared.info !== info) return null
    // The distribution's own Studio launcher: hooks and the gateway written for
    // this machine name it, never the pinned Node or this version's payload
    // folder, which the next update prunes (see `integrations/launcher.ts`).
    // Only once it is on disk; until then, the older form that names them.
    const launcher = prepared.launcherReady ? launcherRefForHome(prepared.home.host, 'posix') : null
    return {
      agentStateSocketPath: prepared.server.agentStateSocket,
      commandRuntime: {
        executable: info.nodePath,
        toCommandPath: (nativePath) => toWslPath(nativePath),
        ...(launcher ? { launcher } : {}),
      },
      pluginDirs: prepared.plugin?.pluginDirs ?? [],
      skillPluginDirs: prepared.plugin?.skillPluginDirs ?? {},
      statusLineScriptPath: prepared.plugin?.statusLineScriptPath ?? null,
      studioMcpEntry: {
        ...(launcher
          ? buildLauncherMcpServer(launcher)
          : { command: info.nodePath, args: [`${info.appDir}/automation/mcp-stdio-bridge.mjs`] }),
        // ELECTRON_RUN_AS_NODE is meaningless to Linux Node; the older form
        // carries it because that is how the workspace tidy recognises it.
        // The bridge reaches the gateway of the distribution's own Studio,
        // whose discovery file is in that server's data directory: an agent
        // reaches the tools of the environment it runs in.
        env: {
          ...(launcher ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
          SPRINTENGINE_USER_DATA_DIR: prepared.server.dataDir,
        },
        // The launch token is never written into a config file; the bridge
        // inherits it from the CLI, which inherits it from the startup script,
        // and presents it to that gateway, which takes the agent from it.
        envVarNames: [MCP_CHANNEL_TOKEN_ENV],
      },
      home: prepared.home,
    }
  }

  // Launch tokens the distribution's Studio is still being told: a launch's
  // files are written (and so its terminal started) only once it knows them.
  const tokensInFlight = new Set<Promise<void>>()

  // A launch file's path as the distribution's server takes it: relative to
  // its launch directory, which every launch file must be inside.
  function sessionRelative(sessionDir: string, hostPath: string): string | null {
    const prefix = `${sessionDir}/`
    return hostPath.startsWith(prefix) && hostPath.length > prefix.length ? hostPath.slice(prefix.length) : null
  }

  // The server a launch was prepared against, while that preparation stands.
  const preparedServer = (): PreparedServer | null => {
    const info = helper.info()
    return info && prepared?.info === info ? prepared.server : null
  }

  const terminalHost = (start: boolean) =>
    deps.distribution ? deps.distribution.terminalHost(distro, { start }) : Promise.resolve(null)

  return {
    id,
    kind: 'wsl',
    pathStyle: 'wsl',
    summary(): ExecutionHostSummary {
      const listed = deps.listed()
      const failure = helper.lastError()
      return {
        id,
        kind: 'wsl',
        label: executionHostLabel(id, 'win32'),
        pathStyle: 'wsl',
        ...(failure ? { state: 'unavailable' as const, reason: failure.message } : wslHostState(listed)),
        isDefaultDistro: listed?.isDefault ?? false,
        enabled: settings()?.enabled === true,
        wslVersion: listed?.version ?? null,
      }
    },
    toHostPath: (nativePath) => toWslPath(nativePath),
    toNativePath,
    async homeDir() {
      // Only the home: a launch's preparation (the server, the plugin copy)
      // is the launch's, and a host with no server reaches the home anyway.
      try {
        const info = helper.info() ?? (await helper.start())
        return prepared?.info === info ? prepared.home : await readHome()
      } catch {
        return null
      }
    },
    prepare,
    retainSession: (leaseId) => deps.distribution?.hold(distro, leaseId),
    releaseSession: (leaseId) => deps.distribution?.release(distro, leaseId),
    agentIntegration: integration,
    launchTarget() {
      const own = settings()
      const server = preparedServer()
      return {
        kind: 'wsl',
        distro,
        env: own?.env ?? {},
        ...(own?.shell ? { shell: own.shell } : {}),
        integration: integration(),
        ...(server ? { sessionDir: server.sessionDir, pidDir: server.pidDir } : {}),
      }
    },
    async writeLaunchFiles(files) {
      await Promise.all([...tokensInFlight])
      if (files.length === 0) return
      const server = preparedServer()
      const host = await terminalHost(true)
      if (!server || !host) throw new Error(`The Studio server in ${distro} is not ready for a terminal.`)
      const write = files.map((file) => {
        const path = sessionRelative(server.sessionDir, file.path)
        if (!path) throw new Error(`${file.path} is not inside the launch directory in ${distro}.`)
        return { path, b64: Buffer.from(file.content, 'utf8').toString('base64') }
      })
      await host.launchFiles({ write })
    },
    discardLaunchFiles(paths) {
      const server = preparedServer()
      if (!server) return
      // Top-level entries only: a Cursor host-context plugin is a directory.
      const names = [
        ...new Set(
          paths.flatMap((path) => (path ? [sessionRelative(server.sessionDir, path)?.split('/')[0] ?? ''] : [])),
        ),
      ].filter(Boolean)
      // Never starts the server: one that is not running holds nothing to tidy.
      if (names.length > 0)
        void terminalHost(false)
          .then((host) => host?.launchFiles({ remove: names }))
          .catch(() => undefined)
    },
    issueChannelToken(identity) {
      // A launch with no agent identity has nothing for a token to prove.
      if (!identity || !deps.distribution) return undefined
      const { token, sent } = deps.distribution.issueLaunchToken(distro, identity)
      tokensInFlight.add(sent)
      void sent.finally(() => tokensInFlight.delete(sent))
      return token
    },
    revokeChannelToken: (token) => deps.distribution?.revokeLaunchToken(distro, token),
    watchDir(nativePath, recursive, listener) {
      const watchers = new EventEmitter() as EventEmitter & { close(): void }
      const handle = helper.watch(toWslPath(nativePath), recursive, listener, () => {
        // Asynchronous by construction (the helper answers later), so the
        // caller's error listener is already attached.
        if (watchers.listenerCount('error') > 0) {
          watchers.emit('error', new Error(`${nativePath} cannot be watched inside ${distro}.`))
        }
      })
      watchers.close = () => handle.close()
      return watchers
    },
    cliRuntime(cli, runtime): CliRuntimeSettings {
      return {
        command: (settings()?.cliCommands[cli] ?? '').trim(),
        ...(runtime?.models ? { models: runtime.models } : {}),
        hostId: id,
      }
    },
    async probeSubtrees(refs: readonly HostProcessRef[]) {
      const result = new Map<string, SubtreeLiveReason | null>()
      const keyed = refs.flatMap((ref) => {
        const key = wslSessionPidKey(ref.startupScriptPath)
        return key ? [{ sessionId: ref.sessionId, key }] : []
      })
      if (keyed.length === 0) return result
      try {
        // A session runs only while its server is held up, so a server that is
        // not running is not started to be asked: every session is undetermined.
        const host = await terminalHost(false)
        const answer = await withDeadline(
          host?.processes({ op: 'snapshot', keys: keyed.map((entry) => entry.key) }),
          SNAPSHOT_TIMEOUT_MS,
        )
        const verdicts = answer?.verdicts ?? {}
        for (const entry of keyed) {
          if (Object.prototype.hasOwnProperty.call(verdicts, entry.key)) {
            result.set(entry.sessionId, verdicts[entry.key] ?? null)
          }
        }
      } catch {
        // Undetermined: every session is held.
      }
      return result
    },
    async killSessionSurvivors(cliSessionId, ref) {
      const key = wslSessionPidKey(ref?.startupScriptPath)
      if (!cliSessionId && !key) return []
      const ask = { op: 'kill' as const, cliSessionId, key: key ?? '' }
      if (ref?.quitting) {
        // The app is quitting: the ptys were ended and waited on already, so
        // there is no grace to give, and a server that is not running is not
        // started for this.
        const host = await terminalHost(false).catch(() => null)
        const answer = await host?.processes(ask).catch(() => null)
        return Array.isArray(answer?.killed) ? answer.killed : []
      }
      // The pty kill reaches the shell first; what is still there after a
      // moment is what would otherwise run on inside the VM.
      if (survivorDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, survivorDelayMs))
      try {
        const host = await terminalHost(true)
        const answer = await host?.processes(ask)
        return Array.isArray(answer?.killed) ? answer.killed : []
      } catch {
        return []
      }
    },
    async detectClis(requests, options = {}) {
      const probes = requests.map(({ cli, runtime }) => cliProbeRequest(cli, { ...runtime, hostId: id }))
      const asked = probes.flatMap((probe) => ('error' in probe ? [] : [probe]))
      let answers: HelperProbeAnswer[] = []
      let failure: string | null = null
      if (asked.length > 0) {
        try {
          const reply = await helper.request<{ results: HelperProbeAnswer[] }>(
            'cli.detect',
            {
              requests: asked.map((probe) => ({ binary: probe.binary, versionArgs: probe.versionArgs })),
              ...(options.force ? { force: true } : {}),
            },
            { timeoutMs: DETECT_TIMEOUT_MS },
          )
          answers = reply.results
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
      }
      let next = 0
      return probes.map((probe): CliDetectResult => {
        if ('error' in probe) return detectResultFromHelper(probe, { error: probe.error }, id)
        const answer = failure ? { error: failure } : (answers[next] ?? { error: 'The helper gave no answer.' })
        next += 1
        return detectResultFromHelper(probe, answer, id)
      })
    },
    async runCommand(argv, options): Promise<RunOutcome> {
      try {
        return await helper.request<HelperRunOutcome>(
          'run',
          { argv: [...argv], ...(options.cwd ? { cwd: toWslPath(options.cwd) } : {}), timeoutMs: options.timeoutMs },
          { timeoutMs: options.timeoutMs + ANSWER_SLACK_MS },
        )
      } catch (error) {
        return failedRun(error)
      }
    },
    async runGit(cwd, args, options) {
      try {
        const outcome = await helper.request<HelperRunOutcome>(
          'git',
          {
            cwd: toWslPath(cwd),
            args: args.map(wslGitArg),
            timeoutMs: options.timeoutMs,
            env: options.env,
            // Base64, so a patch's CRLFs and a pathspec list's NULs cross the
            // JSON wire byte for byte.
            ...(options.stdin !== undefined ? { stdinB64: Buffer.from(options.stdin, 'utf8').toString('base64') } : {}),
          },
          { timeoutMs: options.timeoutMs === null ? null : options.timeoutMs + ANSWER_SLACK_MS },
        )
        return { ...outcome, stdout: nativeGitOutput(args, outcome.stdout, distro) }
      } catch (error) {
        return failedRun(error)
      }
    },
    dispose: () => helper.shutdown(),
  }
}
