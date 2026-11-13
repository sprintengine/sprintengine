import { createAutomationTools, type AutomationBackends } from '../../main/automation/automation-tools'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'

/**
 * The toolsets the shell offers a server out of process (phase 6, 6.3,
 * decision R78): phase 5's browser and canvas, then the editor and tours,
 * which act on a screen the shell holds.
 *
 * The terminals are the server's (studio-agent-terminals.ts), so `terminal.*`,
 * `agent.*` and `backlog.work` are its own tools in every mode. The worktree
 * pool's `worktree` family is the server's, as the pool is (studio-worktree-pool.ts).
 * `artifacts` is the shell's: a publish
 * reads the page from this machine's disk and signs in with its credentials,
 * and its clone of the site is one main keeps. And `visual`: a preview is
 * drawn in a hidden window of the app. `extension` and `plugin` are the
 * server's own (the scaffold and the plugin sources are its extensions').
 */
export const SHELL_TOOLSETS = ['browser', 'canvas', 'editor', 'tour', 'visual', 'artifacts'] as const

/** Whether a gateway tool is one the shell offers, out of process, and not the server's. */
export function isShellToolName(name: string): boolean {
  const dot = name.indexOf('.')
  return dot > 0 && (SHELL_TOOLSETS as readonly string[]).includes(name.slice(0, dot))
}

/** The automation tools a server out of process serves itself: every one but the shell's. */
export function serverAutomationTools(backends: AutomationBackends): McpToolRegistration[] {
  return createAutomationTools(backends).filter((tool) => !isShellToolName(tool.name))
}
