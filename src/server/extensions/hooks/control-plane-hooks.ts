import type { ControlPlaneHooks, ControlPlaneSession } from '../../../main/agent-control-plane'
import { activeInvoker, ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { extensionHookRefusal, type ExtensionHooks } from './extension-hooks'

// Extensions' hooks on the agent control plane: the one way Studio, an
// extension or a tool hands a live agent a message or types into a terminal
// (agent-control-plane.ts). A person's own keystrokes and messages never pass
// through it, so they are never hooked. A message to a chat is checked by the
// runtime's own door, which every send to a chat comes through: the plane only
// says what it is (`chatPrompt`).
//
// Who it runs as: the extension whose call this is, when an extension's code
// asked; otherwise whoever started the agent it goes to (hook-invokers.ts),
// or the person for a terminal with no agent.

export function controlPlaneHooks(
  hooks: ExtensionHooks,
  chatInvoker: (chat: { workspaceId: string; agentId: string }) => ExtensionInvoker,
): ControlPlaneHooks {
  const invokerOf = (session: ControlPlaneSession): ExtensionInvoker =>
    activeInvoker() ??
    (session.workspaceId && session.agentId
      ? chatInvoker({ workspaceId: session.workspaceId, agentId: session.agentId })
      : ownerInvoker(null, 'Studio'))
  // An extension's code asking is the extension sending; anything else the
  // plane carries is Studio's own (a notice).
  const sender = () =>
    activeInvoker()
      ? { from: 'extension' as const, inputKind: 'send' as const }
      : { from: 'studio' as const, inputKind: 'notice' as const }
  return {
    // A chat's message is checked by the runtime's door (conversation-runtime.ts).
    chatPrompt: () => sender(),
    prompt(session, text) {
      if (!hooks.wants('agent.prompt.before')) return null
      return hooks
        .run(
          'agent.prompt.before',
          {
            agent: session.cli ?? null,
            where: 'terminal',
            workspaceId: session.workspaceId ?? null,
            agentId: session.agentId ?? null,
            terminalId: session.sessionId,
            ...sender(),
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
    write(session, text, enter) {
      if (!hooks.wants('terminal.write.before')) return null
      return hooks
        .run(
          'terminal.write.before',
          {
            terminalId: session.sessionId,
            workspaceId: session.workspaceId ?? null,
            agent: session.cli ?? null,
            ...sender(),
            text,
            enter,
          },
          invokerOf(session),
        )
        .then((outcome) =>
          outcome.kind === 'deny'
            ? { ok: false as const, message: extensionHookRefusal(outcome) }
            : { ok: true as const, text: outcome.event.text, enter: outcome.event.enter },
        )
    },
  }
}
