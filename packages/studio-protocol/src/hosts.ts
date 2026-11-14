import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioTopicTable,
} from './contract.js'
import type { ExecutionHostId } from './agents.js'
import { STUDIO_EXECUTION_HOSTS_CAPABILITY } from './handshake.js'
import type { TerminalPathStyle } from './terminals.js'

// The machines a desktop's own computer offers (`hosts.list`, and the
// `hosts.changed` stream): itself, and on Windows its WSL distributions, each
// with how its Studio server stands. What New chat's machine list and
// Settings ▸ Machines draw. Offered as `execution-hosts` by a desktop's
// Studio; a WSL distribution's or an SSH machine's Studio offers none (it is
// one of those machines, not the computer that holds them).
//
// Grants. An owner's (`STUDIO_EXECUTION_HOSTS_OWNER`): a refresh starts
// `wsl.exe` on this computer, and the list names its distributions and why
// one is down. No paired device reaches it; a device reaches a distribution's
// chats through this desktop's `relay:` route (`environment.relayed`), which
// lists only what it may open.

export type ExecutionHostKind = 'posix' | 'windows' | 'wsl'

export type ExecutionHostState = 'ready' | 'stopped' | 'starting' | 'unavailable'

/** How a distribution's Studio server, which holds its chats, stands, in words for Settings. */
export type WslServerSummary = {
  state: 'stopped' | 'starting' | 'ready' | 'unavailable' | 'shut-down'
  /** How Windows reaches it while it is ready: over loopback, or through the stdio bridge. */
  transport?: 'loopback' | 'stdio'
  /** Why it is unavailable or shut down, or why the bridge, in words. */
  reason?: string
}

/** One machine, as the picker and Settings show it. */
export type ExecutionHostSummary = {
  id: ExecutionHostId
  kind: ExecutionHostKind
  /** "This Mac", "This PC (Windows)", "WSL: Ubuntu". */
  label: string
  pathStyle: TerminalPathStyle
  state: ExecutionHostState
  /** Why the host is `unavailable` or `stopped`, in words a person can act on. */
  reason?: string
  /** WSL only: the distribution `wsl.exe` runs when none is named. */
  isDefaultDistro?: boolean
  /** WSL only: whether the person turned this distribution on as a machine. */
  enabled?: boolean
  /** WSL only: 1 or 2, when WSL reported it. */
  wslVersion?: number | null
  /** WSL only: how its Studio server stands. */
  server?: WslServerSummary
}

/**
 * What `hosts.list` answers: this machine first, then WSL distributions (all
 * of them with `all`, the enabled ones otherwise). `wsl` says whether WSL
 * answered at all, and is null off Windows.
 */
export type HostsListResult = {
  hosts: ExecutionHostSummary[]
  wsl: { available: boolean; reason?: string } | null
}

/** Why the machines a computer offers are an owner's. */
export const STUDIO_EXECUTION_HOSTS_OWNER =
  'It lists the machines this computer offers, and a refresh starts WSL here to ask it again.'

export type StudioHostsMethodMap = {
  /**
   * The machines, this one first. WSL is asked only with `refresh` (Settings
   * opening, its Refresh button) or when nothing has been read yet: listing
   * WSL starts a process on Windows.
   */
  'hosts.list': { params: { refresh?: boolean; all?: boolean }; result: HostsListResult }
}

export type StudioHostsTopicMap = {
  /** The list may read differently (a distribution appeared, a setting moved, a server's state changed): ask again. */
  'hosts.changed': { params: Record<string, never>; payload: Record<string, never>; stream: 'push' }
}

const owner = {
  scope: 'workspaces:read',
  capability: STUDIO_EXECUTION_HOSTS_CAPABILITY,
  owner: STUDIO_EXECUTION_HOSTS_OWNER,
} as const

export const STUDIO_HOSTS_METHODS: StudioMethodTable<StudioHostsMethodMap> = {
  'hosts.list': {
    ...owner,
    mutation: false,
    params: (value) => {
      for (const key of ['refresh', 'all'] as const)
        if (value[key] !== undefined && typeof value[key] !== 'boolean')
          return refuse(`"${key}" is true or false, when given.`)
      return studioParams({
        ...(value.refresh === true ? { refresh: true } : {}),
        ...(value.all === true ? { all: true } : {}),
      })
    },
  },
}

export const STUDIO_HOSTS_TOPICS: StudioTopicTable<StudioHostsTopicMap> = {
  'hosts.changed': { ...owner, push: true, params: studioNoParams },
}
