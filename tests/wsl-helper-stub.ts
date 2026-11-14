// A stand-in for one distribution's helper client, for tests of what main does
// with a WSL machine. Each method the helper answers is a handler the test
// supplies; every request is recorded.

import type { WslHelperClient, WslHelperInfo } from '../src/main/hosts/wsl-helper-client'
import type { WslSetupError } from '../src/main/hosts/wsl-setup-error'
import type { WslDistributionFacts, WslDistributionLink, WslMachineAccess } from '../src/main/hosts/wsl-host'
import type { SubtreeLiveReason } from '../src/main/terminal-subtree-probe'
import type {
  StudioEnvironmentGitAsk,
  StudioEnvironmentHome,
  StudioEnvironmentRunOutcome,
  StudioLaunchFile,
  StudioTerminalPluginCopy,
  StudioTerminalProcessesAsk,
} from '../packages/studio-protocol/src/environment-access'
import type { GatewayLaunchIdentity } from '../src/server/core/gateway-launch-tokens'

export const STUB_HELPER_INFO: WslHelperInfo = {
  uid: 1000,
  profile: 'abc123def456',
  home: '/home/dev',
  arch: 'x64',
  nodePath: '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node',
  appDir: '/home/dev/.local/share/sprintengine-studio/0.4.0',
}

export type StubHelper = WslHelperClient & {
  requests: Array<{ method: string; params: unknown; timeoutMs: number | null | undefined }>
  starts: number
  failWith: WslSetupError | null
}

export function stubWslHelper(
  distro: string,
  handlers: Record<string, (params: never) => unknown> = {},
  info: WslHelperInfo = STUB_HELPER_INFO,
): StubHelper {
  let running = false
  const stub: StubHelper = {
    distro,
    requests: [],
    starts: 0,
    failWith: null,
    state: () => (running ? 'ready' : 'stopped'),
    info: () => (running ? info : null),
    lastError: () => stub.failWith,
    async start() {
      stub.starts += 1
      if (stub.failWith) throw stub.failWith
      running = true
      return info
    },
    async request<T>(method: string, params?: unknown, options: { timeoutMs?: number | null } = {}): Promise<T> {
      await stub.start()
      stub.requests.push({ method, params, timeoutMs: options.timeoutMs })
      const handler = handlers[method]
      if (!handler) throw new Error(`The stub helper has no ${method}.`)
      return (await handler(params as never)) as T
    },
    async requestIfRunning<T>(method: string, params?: unknown): Promise<T | null> {
      if (!running) return null
      return stub.request<T>(method, params)
    },
    async shutdown() {
      running = false
    },
  }
  return stub
}

/** The socket a stand-in distribution's Studio server says its terminal agents report to. */
export const STUB_AGENT_STATE_SOCKET = '/home/dev/.local/share/sprintengine-studio/data/agent-state.sock'
/** That server's data directory, where its gateway's discovery file is. */
export const STUB_SERVER_DATA_DIR = '/home/dev/.local/share/sprintengine-studio/data'

/** Where the stand-in server writes launch files, and where each launch's shell records its pid. */
export const STUB_SESSION_DIR = '/home/dev/.local/share/sprintengine-studio/sessions/abc123def456'
export const STUB_PID_DIR = '/run/user/1000/sprintengine/abc123def456/sessions'

/** The Node that server runs on, and its tree's resources (which hold `hooks/` and `automation/`). */
export const STUB_SERVER_NODE = '/home/dev/.local/share/sprintengine-studio/runtime/node-v24.21.0/bin/node'
export const STUB_SERVER_RESOURCES = '/home/dev/.local/share/sprintengine-studio/server-0.4.0/resources'

/** What a stand-in server answers `pluginCopy` with unless told otherwise. */
export const STUB_PLUGIN_COPY: StudioTerminalPluginCopy = {
  pluginDirs: [`${STUB_SERVER_DATA_DIR}/terminal-plugin/sprintengine-studio`],
  skillPluginDirs: { backlog: `${STUB_SERVER_DATA_DIR}/terminal-plugin/launch-skills/backlog` },
  statusLineScriptPath: `${STUB_SERVER_DATA_DIR}/terminal-plugin/sprintengine-studio/hooks/status-line.mjs`,
}

/** The facts a stand-in distribution's server gives a launch. */
export const STUB_SERVER_FACTS = {
  agentStateSocket: STUB_AGENT_STATE_SOCKET,
  dataDir: STUB_SERVER_DATA_DIR,
  sessionDir: STUB_SESSION_DIR,
  pidDir: STUB_PID_DIR,
  nodePath: STUB_SERVER_NODE,
  resourcesDir: STUB_SERVER_RESOURCES,
} as const

export type StubTerminalHostHandlers = {
  launchFiles?: (params: { write?: StudioLaunchFile[]; remove?: string[] }) => { paths: string[] }
  processes?: (
    ask: StudioTerminalProcessesAsk,
  ) =>
    | { verdicts?: Record<string, SubtreeLiveReason | null>; killed?: number[] }
    | Promise<{ verdicts?: Record<string, SubtreeLiveReason | null>; killed?: number[] }>
  pluginCopy?: (enabledSkills: readonly string[]) => StudioTerminalPluginCopy | Promise<StudioTerminalPluginCopy>
}

export type StubDistributionLink = WslDistributionLink & {
  holds: Set<string>
  /** Launch tokens issued and not yet revoked, with the agent each proves. */
  tokens: Map<string, GatewayLaunchIdentity>
  connects: () => number
  /** What its terminal host was asked, in order. */
  asked: Array<{ method: 'launchFiles' | 'processes' | 'pluginCopy'; params: unknown; started: boolean }>
  /** Whether its server runs: one that does not is reached only with `start`. */
  running: boolean
}

/** A stand-in for the core's WSL servers, as a WSL host reaches them: holds, tokens and terminal host asks recorded. */
export function stubWslDistributionLink(
  facts: () => WslDistributionFacts = () => ({ ...STUB_SERVER_FACTS }),
  handlers: StubTerminalHostHandlers = {},
): StubDistributionLink {
  const holds = new Set<string>()
  const tokens = new Map<string, GatewayLaunchIdentity>()
  let connects = 0
  let next = 1
  const link: StubDistributionLink = {
    holds,
    tokens,
    asked: [],
    running: false,
    connects: () => connects,
    connect: async () => {
      connects += 1
      link.running = true
      return facts()
    },
    hold: (distro, key) => void holds.add(`${distro}/${key}`),
    release: (distro, key) => void holds.delete(`${distro}/${key}`),
    issueLaunchToken: (_distro, identity) => {
      const token = `selaunch_stub-${next++}-${'x'.repeat(16)}`
      tokens.set(token, identity)
      return { token, sent: Promise.resolve() }
    },
    revokeLaunchToken: (_distro, token) => void tokens.delete(token),
    terminalHost: async (_distro, { start }) => {
      if (!link.running && !start) return null
      if (start) link.running = true
      return {
        launchFiles: async (params) => {
          link.asked.push({ method: 'launchFiles', params, started: start })
          return handlers.launchFiles ? handlers.launchFiles(params) : { paths: [] }
        },
        processes: async (ask) => {
          link.asked.push({ method: 'processes', params: ask, started: start })
          return handlers.processes ? await handlers.processes(ask) : {}
        },
        pluginCopy: async (enabledSkills) => {
          link.asked.push({ method: 'pluginCopy', params: [...enabledSkills], started: start })
          return handlers.pluginCopy ? await handlers.pluginCopy(enabledSkills) : STUB_PLUGIN_COPY
        },
      }
    },
  }
  return link
}

export type StubWatch = {
  path: string
  recursive: boolean
  listener: (filename: string | null) => void
  onError: () => void
  closed: boolean
}

export type StubMachine = WslMachineAccess & {
  /** What the distribution's Studio was asked, in order. */
  asked: Array<{ method: 'git' | 'home'; distro: string; ask?: StudioEnvironmentGitAsk }>
  watches: StubWatch[]
}

/** A stand-in for a distribution's Studio as git, the home and watches reach it. */
export function stubWslMachine(
  handlers: {
    git?: (ask: StudioEnvironmentGitAsk) => StudioEnvironmentRunOutcome | Promise<StudioEnvironmentRunOutcome>
    home?: () => StudioEnvironmentHome | Promise<StudioEnvironmentHome>
  } = {},
): StubMachine {
  const machine: StubMachine = {
    asked: [],
    watches: [],
    async git(distro, ask) {
      machine.asked.push({ method: 'git', distro, ask })
      if (!handlers.git) throw new Error('The stub machine runs no git.')
      return handlers.git(ask)
    },
    async home(distro) {
      machine.asked.push({ method: 'home', distro })
      return handlers.home ? handlers.home() : { home: '/home/dev', env: {} }
    },
    watchPath(_distro, path, recursive, listener, onError) {
      const entry: StubWatch = { path, recursive, listener, onError, closed: false }
      machine.watches.push(entry)
      return {
        close() {
          entry.closed = true
        },
      }
    },
  }
  return machine
}
