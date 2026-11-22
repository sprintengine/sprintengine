import type { ControlPlaneHooks, ControlPlaneSession } from '../../../main/agent-control-plane'
import { activeInvoker, ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { extensionHookRefusal, type ExtensionHooks } from './extension-hooks'

// Extensions' hooks on the agent control plane: the one way Studio, an
// extension or a tool hands a live agent a message or types into a terminal
// (agent-control-plane.ts). A person's own keystrokes and messages never pass
// through it, so they are never hooked.
//
// Who it runs as: the extension whose call this is, when an extension's code
// asked; otherwise the chat's starter, or (for a terminal, which only the
// person's own windows and agents reach) the person.

export function controlPlaneHooks(
  hooks: ExtensionHooks,
  chatInvoker: (chat: { workspaceId: string; agentId: string }) => ExtensionInvoker,
): ControlPlaneHooks {
  const invokerOf = (session: ControlPlaneSession): ExtensionInvoker =>
    activeInvoker() ??
    (session.transport === 'conversation' && session.workspaceId && session.agentId
      ? chatInvoker({ workspaceId: session.workspaceId, agentId: session.agentId })
      : ownerInvoker(null, 'Studio'))
  return {
    prompt(session, text) {
      if (!hooks.wants('agent.prompt.before')) return null
      const from = activeInvoker() ? 'extension' : 'studio'
      return hooks
        .run(
          'agent.prompt.before',
          {
            agent: session.providerId ?? session.cli ?? null,
            where: session.transport === 'conversation' ? 'chat' : 'terminal',
            workspaceId: session.workspaceId ?? null,
            agentId: session.agentId ?? null,
            from,
            prompt: text,
          },
          invokerOf(session),
        )
        .then((outcome) =>
          outcome.kind === 'deny'
            ? { ok: false as const, message: extensionHookRefusal(outcome) }
            : { ok: true as const, text: outcome.event.prompt },
        )
    },
    write(session, data) {
      if (!hooks.wants('terminal.write.before')) return null
      return hooks
        .run(
          'terminal.write.before',
          {
            terminalId: session.sessionId,
            workspaceId: session.workspaceId ?? null,
            agent: session.cli ?? null,
            text: data,
          },
          invokerOf(session),
        )
        .then((outcome) =>
          outcome.kind === 'deny'
            ? { ok: false as const, message: extensionHookRefusal(outcome) }
            : { ok: true as const, text: outcome.event.text },
        )
    },
  }
}
