import type { TerminalRuntimeOptions } from '../../main/terminal-runtime'

/**
 * What the desktop's shell adds to a terminal agent's launch before its pty
 * starts: the CLI's per-launch integration (its flags, environment and the
 * app's plugin directories), the MCP config synced into the folder, a bundled
 * skill the prompt invokes, the generated config kept out of a connector
 * worktree's git, and the agent-state hook written where the CLI reads it.
 *
 * Each is built from what only the shell keeps: the plugin copy it
 * materialises for this build, the launcher it writes, its MCP and skill
 * services. The terminal runtime runs in the Studio server
 * (studio-agent-terminals.ts) and asks for these through the shell bridge:
 * directly in process, over the control channel out of process. Every input
 * and answer is plain data. A Studio with no shell (a standalone server)
 * launches without them, as a terminal started by hand would.
 */
export type TerminalLaunchPreparation = Required<
  Pick<
    TerminalRuntimeOptions,
    | 'prepareLaunchIntegration'
    | 'syncMcpConfig'
    | 'ensureBuiltinSkillInstalled'
    | 'excludeWorktreeMcpConfig'
    | 'prepareAgentStateHook'
  >
>
