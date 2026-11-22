import type { TerminalSpawnResult } from '../../../../packages/studio-protocol/src/terminals'
import type { TerminalSpawnPayload } from '../../../main/terminal-spawn-payload'
import { activeInvoker, ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import type { AgentStarter } from '../../../shared/agent-state'
import type { ConversationPromptHookAs } from '../../../shared/conversation-runtime'
import { extensionHookRefusal, type ExtensionHooks } from './extension-hooks'

// The one door a new terminal agent comes through: the terminal runtime's
// spawn, which the launch service and a window's pane opening (`terminal.open`
// from a tab strip's new agent) both reach. An agent's pty that is already
// running (a pane attaching) or is resumed is not a new agent and is not
// hooked; a new one meets the extensions' `agent.launch.before`, and a refusal
// is the spawn's own failure, in words naming the extension. Its first prompt,
// when nobody typed it (the launch service says so), then meets
// `agent.prompt.before` as a `launch`: changed, it is what the agent is
// handed; refused, the agent does not start.

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
    if (!hooks || !fresh) return deps.spawn(viewer, payload)
    const refused = (message: string): TerminalSpawnResult => ({
      ok: false,
      sessionId: payload.sessionId,
      message,
      exitCode: 1,
    })
    const prompt = payload.initialPrompt?.trim() || null
    if (hooks.wants('agent.launch.before')) {
      const outcome = await hooks.run(
        'agent.launch.before',
        {
          agent: payload.cli ?? 'terminal',
          where: 'terminal',
          workspaceId: payload.workspaceId ?? '',
          model: payload.cliModel ?? null,
          permission: payload.cliPermissionPreset ?? null,
          prompt,
        },
        deps.invokerOf(payload),
      )
      if (outcome.kind === 'deny') return refused(extensionHookRefusal(outcome))
    }
    let next = payload
    if (prompt && payload.initialPromptHookAs && hooks.wants('agent.prompt.before')) {
      const outcome = await hooks.run(
        'agent.prompt.before',
        {
          agent: payload.cli ?? null,
          where: 'terminal',
          workspaceId: payload.workspaceId ?? null,
          agentId: payload.agentId ?? null,
          terminalId: payload.sessionId,
          from: payload.initialPromptHookAs.from,
          inputKind: payload.initialPromptHookAs.inputKind,
          prompt: payload.initialPrompt!,
        },
        deps.invokerOf(payload),
      )
      if (outcome.kind === 'deny') return refused(extensionHookRefusal(outcome))
      next = { ...payload, initialPrompt: outcome.event.prompt }
    }
    return deps.spawn(viewer, next)
  }
}

/**
 * Who a terminal agent's spawn runs its hooks as: the extension whose call it
 * is; else who asked for it, as the launch service carried it in (its record
 * is not registered yet), held to its preset; else its record's starter; else,
 * for a terminal with no agent, the person.
 */
export function spawnInvokerOf(deps: {
  agentInvoker?: (agent: { startedBy?: AgentStarter; cliPermissionPreset?: unknown }) => ExtensionInvoker
  chatInvoker?: (chat: { workspaceId: string; agentId: string }) => ExtensionInvoker
}): (payload: TerminalSpawnPayload) => ExtensionInvoker {
  return (payload) =>
    activeInvoker() ??
    (payload.startedBy && deps.agentInvoker
      ? deps.agentInvoker({ startedBy: payload.startedBy, cliPermissionPreset: payload.cliPermissionPreset })
      : payload.workspaceId && payload.agentId && deps.chatInvoker
        ? deps.chatInvoker({ workspaceId: payload.workspaceId, agentId: payload.agentId })
        : ownerInvoker(null, 'you'))
}

/**
 * A prompt Studio types to a terminal agent that nobody typed (a tour's),
 * through the extensions' `agent.prompt.before` first: what to type, or the
 * refusal naming the extension. Run as the extension whose call it is, else
 * `invoker` (the agent's starter).
 */
export async function hookTerminalPrompt(
  hooks: ExtensionHooks | undefined,
  session: { sessionId: string; cli?: string | null; workspaceId?: string | null; agentId?: string | null },
  text: string,
  hookAs: Omit<ConversationPromptHookAs, 'starter'>,
  invoker: () => ExtensionInvoker,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!hooks?.wants('agent.prompt.before')) return { ok: true, text }
  const outcome = await hooks.run(
    'agent.prompt.before',
    {
      agent: session.cli ?? null,
      where: 'terminal',
      workspaceId: session.workspaceId ?? null,
      agentId: session.agentId ?? null,
      terminalId: session.sessionId,
      from: hookAs.from,
      inputKind: hookAs.inputKind,
      prompt: text,
    },
    activeInvoker() ?? invoker(),
  )
  return outcome.kind === 'deny'
    ? { ok: false, message: extensionHookRefusal(outcome) }
    : { ok: true, text: outcome.event.prompt }
}
