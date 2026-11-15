// Where a WSL distribution keeps a CLI's files, as this (Windows) process can
// reach them. The Skills tab reads it to list what a CLI in WSL has installed.
//
// The answer comes from the distribution's own Studio server, which read the
// person's login shell when it started: the home, and the config-home variables that
// move a CLI's files (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`),
// each already turned into the UNC path Windows opens it by.

import { wslHostId } from '../shared/execution-host'
import { wslToWindowsPath } from '../shared/host-paths'
import type { ExecutionHost } from './hosts/execution-host'
import { hostRegistry } from './hosts/host-registry'
import { resolveDefaultWslDistro } from './hosts/wsl-distro'

/**
 * The Linux home and the distribution root as UNC paths, and the config-home
 * variables already converted the same way.
 */
export type WslHome = { home: string; root: string; env: NodeJS.ProcessEnv }

export type WslHomeProbe = (distro?: string | null) => Promise<WslHome | null>

export function createWslHomeProbe(
  deps: {
    hostFor?: (distro: string) => Pick<ExecutionHost, 'homeDir'>
    resolveDefaultDistro?: () => Promise<string | null>
  } = {},
): WslHomeProbe {
  const hostFor = deps.hostFor ?? ((distro: string) => hostRegistry().get(wslHostId(distro)))
  const resolveDefaultDistro = deps.resolveDefaultDistro ?? (() => resolveDefaultWslDistro())
  return async (requested) => {
    const distro = requested ?? (await resolveDefaultDistro().catch(() => null))
    if (!distro) return null
    const home = await hostFor(distro)
      .homeDir()
      .catch(() => null)
    if (!home) return null
    return { home: home.native, root: wslToWindowsPath('/', { distro }), env: { ...home.env } }
  }
}

/** The app's one probe. A WSL host keeps the answer of its last launch preparation. */
export const probeWslHome: WslHomeProbe = createWslHomeProbe()
