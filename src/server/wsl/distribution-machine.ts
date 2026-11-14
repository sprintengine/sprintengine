import { homedir } from 'node:os'

import type {
  StudioEnvironmentGitAsk,
  StudioEnvironmentHome,
  StudioEnvironmentRunOutcome,
} from '../../../packages/studio-protocol/src/environment-access'
import { checkRunRequest, decodeStdin, killAllChildren, runArgv } from '../../../resources/wsl-helper/lib/run.mjs'

// What a WSL distribution's Studio does on its machine for the desktop that
// holds it, beyond that desktop's terminals (`distribution-terminal-host.ts`):
// git in a folder here, for the desktop's WSL terminal workspaces (their
// worktrees, checkpoints and Git pane), and the home and config-home variables
// the person's login shell sets, which the desktop reads a CLI's files by.
// Asked over the desktop's owner connection (`environment.git`,
// `environment.home`, the shell's).
//
// This server adopted the login shell's environment before it said `ready`
// (`headless.ts`), so git runs with the person's PATH and settings, as the
// server's own does.

export type DistributionMachine = {
  git(ask: StudioEnvironmentGitAsk): Promise<StudioEnvironmentRunOutcome>
  home(): StudioEnvironmentHome
  /** Ends every git still running: the server is stopping. */
  close(): void
}

export function createDistributionMachine(
  options: { env?: () => Record<string, string | undefined> } = {},
): DistributionMachine {
  const env = options.env ?? (() => process.env)
  return {
    async git(ask) {
      const request = {
        argv: ['git', '-C', ask.cwd, ...ask.args],
        cwd: ask.cwd,
        timeoutMs: ask.timeoutMs,
        env: ask.env,
      }
      const problem = checkRunRequest(request)
      if (problem) throw new Error(problem)
      const stdin = decodeStdin(ask.stdinB64)
      if (stdin === null) throw new Error('stdinB64 must be base64 text.')
      return runArgv({ ...request, env: { ...env(), ...ask.env }, ...(stdin ? { stdin } : {}) })
    },
    home() {
      const vars = env()
      const absolute = (value: string | undefined) => (value && value.startsWith('/') ? value : undefined)
      // Claude Code takes a comma-separated list; the first is the one it writes.
      const claude = absolute(vars.CLAUDE_CONFIG_DIR?.split(',')[0])
      const codex = absolute(vars.CODEX_HOME)
      const xdg = absolute(vars.XDG_CONFIG_HOME)
      return {
        home: absolute(vars.HOME) ?? homedir(),
        env: {
          ...(claude ? { CLAUDE_CONFIG_DIR: claude } : {}),
          ...(codex ? { CODEX_HOME: codex } : {}),
          ...(xdg ? { XDG_CONFIG_HOME: xdg } : {}),
        },
      }
    },
    close: () => killAllChildren(),
  }
}
