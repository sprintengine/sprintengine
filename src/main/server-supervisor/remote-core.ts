import type { StudioTransportFactory } from '../../../packages/client-runtime/src/public'
import type { ControlRpc } from '../../server/bootstrap/control-rpc'
import { SERVER_EVENTS, SERVER_METHODS } from '../../server/desktop/server-methods'
import { gitHostIdForPath } from '../../shared/execution-host'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { installGitHostResolver } from '../git-run'
import { createHostRegistry, installHostRegistry, type HostRegistry } from '../hosts/host-registry'
import { setWorktreeBranchPrefixReader } from '../worktree-branch-prefix'
import type { TerminalRootInfo } from '../workspace-memory'
import type { GitHubTokenStatus, GitHubTokenStore } from '../github-token-store'
import type { ServerStateMirror } from './server-mirror'
import type {
  StudioCliProbeAnswer,
  StudioEnvironmentHome,
  StudioEnvironmentRunOutcome,
} from '../../../packages/studio-protocol/src/environment-access'

// The shell's view of the core, which the Studio server holds in a process of
// its own (phase 6 spec, sections 5 and 7.3). The shell builds no
// server-owned store: what it reads synchronously comes from the mirror, what
// it writes or asks goes over the control channel, and the machines its
// terminals and git run on come from a host registry of its own over the
// mirrored settings. Typed as the slice the shell uses, so reaching for
// anything else of the core fails typecheck.

export type ShellServerLink = {
  rpc: ControlRpc
  mirror: ServerStateMirror
  /** Waits until the server is serving (or gives up after the budget). */
  whenServing(budgetMs: number): Promise<boolean>
  isServing(): boolean
  /** Every time a server says ready: the first, and each restart's. */
  onServing(listener: () => void): () => void
  /**
   * Connections for the shell's own Studio client to its server, each over a
   * port the shell brokers on the control channel, with the shell role. Called
   * again for every reconnect, so a restarted server is reached too.
   */
  shellTransport(): StudioTransportFactory
  /** Hand the server a port spliced onto an SSH machine's relay stream (phase 8). False while it restarts. */
  attachSshPort?(clientId: string, port: Electron.MessagePortMain): boolean
}

/** The slice of the core the shell reads, from the mirror and over the control channel. */
export type ShellCore = {
  agentLaunchSettings: ServerStateMirror['launchSettings']
  hosts: HostRegistry
  workspaceRegistry: ServerStateMirror['registry']
  workspaceSyncService: ServerStateMirror['workspaceSync']
  conversations: {
    /** The folders the server's chats run in, for Diagnostics' per-workspace memory (the last answer). */
    listLiveConversationRoots(): TerminalRootInfo[]
  }
  conversationOwner: {
    /** One idle setting governs terminals and chats; the chats' half is the server's. */
    setIdleThresholdMs(value: number): void
  }
}

// How long a WSL ask forwarded to the server may take to reach a distribution's
// Studio that has to be started (or installed) first, and the bound on a git
// that has no deadline of its own.
const SERVER_START_MS = 5 * 60_000
const NO_DEADLINE_MS = 24 * 60 * 60_000

export function createRemoteCore(link: ShellServerLink): ShellCore {
  const { mirror, rpc } = link
  // The machines this computer offers, for the shell's terminal launches: one
  // registry in each process, over the same settings.
  const hosts = createHostRegistry({
    readHostSettings: () => mirror.launchSettings.get().hosts,
    // Git, the home, CLI detection and running a program in a WSL
    // distribution are its own Studio's, which the server holds; watches are
    // the server's alone (its checkouts).
    // The first ask may start (or install) that Studio: minutes, not the
    // control channel's usual seconds; a git with no deadline has none here.
    machine: {
      git: (distro, ask) =>
        rpc.call<StudioEnvironmentRunOutcome>(
          SERVER_METHODS.wslMachine,
          { distro, method: 'git', ask },
          { timeoutMs: ask.timeoutMs === null ? NO_DEADLINE_MS : ask.timeoutMs + SERVER_START_MS },
        ),
      home: (distro) =>
        rpc.call<StudioEnvironmentHome>(
          SERVER_METHODS.wslMachine,
          { distro, method: 'home' },
          { timeoutMs: SERVER_START_MS },
        ),
      detectClis: (distro, requests, force) =>
        rpc.call<StudioCliProbeAnswer[]>(
          SERVER_METHODS.wslMachine,
          { distro, method: 'detectClis', ask: { requests, force } },
          { timeoutMs: SERVER_START_MS },
        ),
      run: (distro, ask) =>
        rpc.call<StudioEnvironmentRunOutcome>(
          SERVER_METHODS.wslMachine,
          { distro, method: 'run', ask },
          { timeoutMs: ask.timeoutMs + SERVER_START_MS },
        ),
    },
  })
  installHostRegistry(hosts)
  // The worktree branch prefix the shell names its own worktrees with (a New
  // chat's, a pool lease's), from the same settings the server names its by.
  setWorktreeBranchPrefixReader(() => effectiveAgentLaunchSettings(mirror.launchSettings.get()).worktreeBranchPrefix)
  let lastHosts = JSON.stringify(mirror.launchSettings.get().hosts)
  mirror.launchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHosts) return
    lastHosts = next
    hosts.notifyChanged()
  })
  // The git panel's git for a repository runs on the machine of the open
  // workspace holding it, as the core arranges in process (`gitHostIdForPath`).
  // The server installs the same rule for its own git; this is the shell's,
  // for the panel it keeps.
  installGitHostResolver((cwd) => {
    if (process.platform !== 'win32') return null
    const id = gitHostIdForPath(cwd, mirror.workspaceSync.getSnapshot().state.workspaces)
    return id ? hosts.get(id) : null
  })

  // The folders the server's chats run in, for Diagnostics' per-workspace
  // memory, which reads them synchronously: each read answers the last list
  // and asks for the next, and the panel polls while it is open.
  let conversationRoots: TerminalRootInfo[] = []
  let rootsInFlight = false
  const readConversationRoots = (): TerminalRootInfo[] => {
    if (!link.isServing()) {
      conversationRoots = []
      return conversationRoots
    }
    if (!rootsInFlight) {
      rootsInFlight = true
      rpc
        .call<TerminalRootInfo[]>(SERVER_METHODS.conversationRoots)
        .then(
          (roots) => {
            conversationRoots = Array.isArray(roots) ? roots : []
          },
          () => undefined,
        )
        .finally(() => {
          rootsInFlight = false
        })
    }
    return conversationRoots
  }

  return {
    agentLaunchSettings: mirror.launchSettings,
    hosts,
    workspaceRegistry: mirror.registry,
    workspaceSyncService: mirror.workspaceSync,
    conversations: { listLiveConversationRoots: readConversationRoots },
    conversationOwner: {
      setIdleThresholdMs: (value) => rpc.emit(SERVER_EVENTS.conversationIdleThreshold, value),
    },
  }
}

/** The GitHub token, which the server keeps: the shell's skills, cards and marketplace ask for it. */
export function createRemoteGitHubTokenStore(
  rpc: Pick<ControlRpc, 'call'>,
): Pick<GitHubTokenStore, 'getStatus' | 'resolveToken' | 'readToken' | 'writeToken' | 'clearToken'> {
  const ask = <T>(op: string, extra: Record<string, unknown> = {}) =>
    rpc.call<T>(SERVER_METHODS.githubToken, { op, ...extra })
  return {
    getStatus: () => ask<GitHubTokenStatus>('status'),
    // A token is only ever a convenience to a read: with no server, there is none.
    resolveToken: (explicit?: string | null) =>
      ask<string>('resolve', explicit ? { explicit } : {}).catch(() => explicit?.trim() || ''),
    readToken: () => ask<string | null>('read').catch(() => null),
    writeToken: (token: string) => ask<GitHubTokenStatus>('write', { token }),
    clearToken: () => ask<GitHubTokenStatus>('clear'),
  }
}
