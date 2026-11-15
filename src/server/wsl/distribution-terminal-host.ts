import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  StudioLaunchFile,
  StudioSubtreeLiveReason,
  StudioTerminalPluginCopy,
  StudioTerminalProcessesAsk,
} from '../../../packages/studio-protocol/src/environment-access'
import { createDistributionPluginCopies } from './distribution-plugin-copy'
import { endAllSessions, snapshot, survivorPids } from './distribution/proc.mjs'
import { clearSessionDir, ensureSessionDir, removeSessionEntries, writeSessionFiles } from './distribution/sessions.mjs'
import { ensurePrivateDir, ensureSocketDir } from './distribution/sockets.mjs'

// What a WSL distribution's Studio does inside it for the desktop's WSL
// terminals, which are that desktop's `wsl.exe` ptys (owner ruling: no second
// terminal path). The terminal itself starts from Windows; what has to happen
// inside Linux happens here, asked over the desktop's owner connection
// (`environment.launchFiles`, `environment.terminalProcesses`, the shell's):
//
//   - each launch's startup script and host-context file are written into a
//     directory only this user can enter, and run from there, never through a
//     `/mnt/<drive>` mount (`distribution/sessions.mjs`);
//   - each startup script records its shell's Linux pid in a private
//     directory, which the idle reaper's verdicts and the survivor kill read
//     against /proc (`distribution/proc.mjs`): closing `wsl.exe` does not
//     reliably end the Linux processes under it;
//   - the app's Claude plugin copy a terminal's agent loads is built here from
//     this server's own resources and written under its data directory
//     (`distribution-plugin-copy.ts`, `environment.pluginCopy`).
//
// Both directories are said to the desktop in the `ready` frame, so the
// startup scripts it writes name them.

export type DistributionTerminalHost = {
  /** Where launch files are written; what a startup script lives in. */
  readonly sessionDir: string
  /** Where each session's shell records its pid. */
  readonly pidDir: string
  launchFiles(params: { write?: StudioLaunchFile[]; remove?: string[] }): { paths: string[] }
  processes(
    ask: StudioTerminalProcessesAsk,
  ): Promise<{ verdicts?: Record<string, StudioSubtreeLiveReason | null>; killed?: number[] }>
  /** The plugin copy with the Studio skills the person chose, written if it changed. */
  pluginCopy(enabledSkills: readonly string[]): Promise<StudioTerminalPluginCopy>
}

export type DistributionTerminalHostOptions = {
  /** The desktop profile this server serves: its directories are that profile's own. */
  profile: string
  /**
   * What the plugin copy is built from and for: this server's resources
   * directory (null: none, so no copy), its data directory, where the copy is
   * written and its gateway's discovery file is, and its agent-state socket.
   */
  plugin: { resourcesDir: string | null; dataDir: string; agentStateSocketPath: string; nodeCommand?: string }
  home?: string
  env?: Record<string, string | undefined>
  uid?: number
  /** Tests point these elsewhere. */
  procRoot?: string
  runtimeBase?: string
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

export function createDistributionTerminalHost(options: DistributionTerminalHostOptions): DistributionTerminalHost {
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  const home = options.home ?? (process.env.HOME || homedir())
  const procRoot = options.procRoot ?? '/proc'
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const sessionDir = ensureSessionDir({ home, ...(uid !== undefined ? { uid } : {}), profile: options.profile })
  const runtimeDir = ensureSocketDir({
    env: options.env ?? process.env,
    ...(uid !== undefined ? { uid } : {}),
    profile: options.profile,
    ...(options.runtimeBase ? { base: options.runtimeBase } : {}),
  })
  const pidDir = ensurePrivateDir(join(runtimeDir, 'sessions'), uid)
  const plugins = createDistributionPluginCopies(options.plugin)

  return {
    sessionDir,
    pidDir,
    pluginCopy: (enabledSkills) => plugins.ensure(enabledSkills),
    launchFiles({ write, remove }) {
      if (remove) removeSessionEntries(sessionDir, remove)
      return { paths: write ? writeSessionFiles(sessionDir, write) : [] }
    },
    async processes(ask) {
      if (ask.op === 'snapshot')
        return {
          verdicts: await snapshot({ procRoot, pidDir, keys: ask.keys, ...(uid !== undefined ? { uid } : {}) }),
        }
      if (ask.op === 'kill') {
        const killed: number[] = []
        for (const pid of survivorPids({
          procRoot,
          pidDir,
          cliSessionId: ask.cliSessionId,
          key: ask.key,
          ...(uid !== undefined ? { uid } : {}),
          selfPid: process.pid,
        })) {
          try {
            kill(pid, 'SIGKILL')
            killed.push(pid)
          } catch {
            // Gone between the read and the kill, which is the goal.
          }
        }
        // The pid file goes with its session.
        if (ask.key) removeSessionEntries(pidDir, [`${ask.key}.pid`])
        return { killed }
      }
      const killed = endAllSessions({
        procRoot,
        pidDir,
        ...(uid !== undefined ? { uid } : {}),
        selfPid: process.pid,
        kill: (pid, signal) => kill(pid, signal as NodeJS.Signals),
      })
      clearSessionDir(sessionDir)
      return { killed }
    },
  }
}
