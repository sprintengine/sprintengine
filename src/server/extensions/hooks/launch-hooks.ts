import type { TerminalSpawnResult } from '../../../../packages/studio-protocol/src/terminals'
import type { TerminalSpawnPayload } from '../../../main/terminal-spawn-payload'
import type { ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { extensionHookRefusal, type ExtensionHooks } from './extension-hooks'

// The one door a new terminal agent comes through: the terminal runtime's
// spawn, which the launch service and a window's pane opening (`terminal.open`
// from a tab strip's new agent) both reach. An agent's pty that is already
// running (a pane attaching) or is resumed is not a new agent and is not
// hooked; a new one meets the extensions' `agent.launch.before`, and a refusal
// is the spawn's own failure, in words naming the extension.

export function guardTerminalSpawn<V>(deps: {
  spawn: (viewer: V, payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult>
  /** Whether a session with this id runs now. */
  live: (sessionId: string) => boolean
  hooks: ExtensionHooks | undefined
  invokerOf: (payload: TerminalSpawnPayload) => ExtensionInvoker
}): (viewer: V, payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult> {
  return async (viewer, payload) => {
    const hooks = deps.hooks
    const fresh = payload.kind === 'agent' && !payload.resume && !deps.live(payload.sessionId)
    if (hooks && fresh && hooks.wants('agent.launch.before')) {
      const outcome = await hooks.run(
        'agent.launch.before',
        {
          agent: payload.cli ?? 'terminal',
          where: 'terminal',
          workspaceId: payload.workspaceId ?? '',
          model: payload.cliModel ?? null,
          permission: payload.cliPermissionPreset ?? null,
          prompt: payload.initialPrompt?.trim() || null,
        },
        deps.invokerOf(payload),
      )
      if (outcome.kind === 'deny')
        return { ok: false, sessionId: payload.sessionId, message: extensionHookRefusal(outcome), exitCode: 1 }
    }
    return deps.spawn(viewer, payload)
  }
}
