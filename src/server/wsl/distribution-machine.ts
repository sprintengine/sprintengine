import { homedir } from 'node:os'

import type {
  StudioCliProbeAnswer,
  StudioCliProbeAsk,
  StudioEnvironmentGitAsk,
  StudioEnvironmentHome,
  StudioEnvironmentRunAsk,
  StudioEnvironmentRunOutcome,
} from '../../../packages/studio-protocol/src/environment-access'
import { createCliDetector } from './distribution/cli-detect.mjs'
import { checkRunRequest, decodeStdin, killAllChildren, runArgv } from './distribution/run.mjs'

// What a WSL distribution's Studio does on its machine for the desktop that
// holds it, beyond that desktop's terminals (`distribution-terminal-host.ts`):
// git in a folder here, for the desktop's WSL terminal workspaces (their
// worktrees, checkpoints and Git pane); the home and config-home variables
// the person's login shell sets, which the desktop reads a CLI's files by;
// which agent CLIs are installed here, and running a program (`gh` checks, a
// CLI's install, MCP sync). Asked over the desktop's owner connection
// (`environment.git`, `.home`, `.detectClis`, `.run`, the shell's), and a
// change on the PATH said on `environment.cliPathsChanged`.
//
// This server adopted the login shell's environment before it said `ready`
// (`headless.ts`), so git runs with the person's PATH and settings, as the
// server's own does.

export type DistributionMachine = {
  git(ask: StudioEnvironmentGitAsk): Promise<StudioEnvironmentRunOutcome>
  home(): StudioEnvironmentHome
  detectClis(requests: StudioCliProbeAsk[], options: { force: boolean }): Promise<StudioCliProbeAnswer[]>
  run(ask: StudioEnvironmentRunAsk): Promise<StudioEnvironmentRunOutcome>
  /** A PATH directory changed (a CLI installed or removed): detect again. Returns the unsubscriber. */
  onPathsChanged(listener: () => void): () => void
  /** Ends every program still running and stops watching the PATH: the server is stopping. */
  close(): void
}

export function createDistributionMachine(
  options: { env?: () => Record<string, string | undefined> } = {},
): DistributionMachine {
  const env = options.env ?? (() => process.env)
  const pathListeners = new Set<() => void>()
  const detector = createCliDetector({
    getEnv: env,
    onPathsChanged: () => {
      for (const listener of [...pathListeners]) listener()
    },
  })
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
    detectClis: (requests, { force }) => detector.detect(requests, { force }),
    async run(ask) {
      const problem = checkRunRequest(ask)
      if (problem) throw new Error(problem)
      return runArgv({ argv: ask.argv, cwd: ask.cwd, timeoutMs: ask.timeoutMs, env: { ...env(), ...ask.env } })
    },
    onPathsChanged(listener) {
      pathListeners.add(listener)
      return () => void pathListeners.delete(listener)
    },
    close() {
      detector.close()
      killAllChildren()
    },
  }
}
