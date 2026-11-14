import type { WslTerminalHostClient } from '../../main/hosts/wsl-host'
import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'

// This desktop's side of what a WSL distribution's Studio does for its WSL
// terminals (`distribution-terminal-host.ts`), over the owner connection.
//
// Ending what earlier sessions left: the first connection this run makes to a
// distribution's server ends every session its pid files still name (they
// were launched by a desktop run that is gone: its `wsl.exe` ptys went with
// it, and nothing will manage them again), and so does quitting, for every
// server still running.

/** The terminal host on one connection's server. */
export function terminalHostOf(connection: Pick<WslServerConnection, 'owner'>): WslTerminalHostClient {
  return {
    launchFiles: (params) => connection.owner.request('environment.launchFiles', params),
    processes: (ask) => connection.owner.request('environment.terminalProcesses', ask),
    pluginCopy: (enabledSkills) =>
      connection.owner.request('environment.pluginCopy', { enabledSkills: [...enabledSkills] }),
  }
}

export type WslTerminalSessions = {
  /** A connection to a distribution's server: the run's first to it ends what an earlier run left. */
  connected(connection: Pick<WslServerConnection, 'distro' | 'owner'>): void
  /** Quitting: every running server ends the sessions this desktop launched there, within `budgetMs`. */
  endAll(budgetMs: number): Promise<void>
}

export function createWslTerminalSessions(
  manager: Pick<WslEnvironmentManager, 'current' | 'statuses'>,
  log: (message: string) => void = () => undefined,
): WslTerminalSessions {
  const seen = new Set<string>()
  const endAllOn = (distro: string, connection: Pick<WslServerConnection, 'owner'>) =>
    terminalHostOf(connection)
      .processes({ op: 'endAll' })
      .then(
        (answer) => {
          if (answer.killed?.length)
            log(`Ended ${answer.killed.length} processes that WSL terminals left running in ${distro}.`)
        },
        (error: unknown) =>
          log(
            `The Studio server in ${distro} did not end what its WSL terminals left: ${error instanceof Error ? error.message : String(error)}`,
          ),
      )
  return {
    connected(connection) {
      if (seen.has(connection.distro)) return
      seen.add(connection.distro)
      void endAllOn(connection.distro, connection)
    },
    async endAll(budgetMs) {
      const running = manager.statuses().flatMap((status) => {
        const connection = manager.current(status.distro)
        return connection ? [endAllOn(status.distro, connection)] : []
      })
      await Promise.race([Promise.all(running), new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.())])
    },
  }
}
