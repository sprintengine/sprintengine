import type { AgentPhaseEvent } from '../shared/agent-runtime'
import type { AgentNotificationMode } from '../shared/agent-notifications'
import type { ShellNotice } from '../server/shell-bridge/shell-bridge'
import { isAttentionEvent } from './agent-attention'

// OS banners for a chat that finished its turn or stopped to ask, while the
// person is in another app. The dock bounce and the badge (agent-attention.ts)
// say that SOMETHING wants them; the banner says which chat and what, and a
// click on it opens that chat.
//
// The same rule as the pairing banners (tailnet-notifications.ts): only when
// no Studio window has focus — someone looking at the app sees the sidebar
// change — and only behind its own setting. A later banner for the same agent
// replaces the earlier one, so a chat that finished three turns while the
// person was away shows one banner, the latest.
//
// A click opens the chat by its address: the environment whose runtime raised
// the phase, and the chat's id there. Every phase here is this desktop's
// runtime's, whose chats (here, in WSL, on SSH machines) this desktop's Studio
// holds, so they are addressed under its environment id.
//
// Pure: the events in, the notice out. The shell's bridge shows it, in process
// or for the server in its own process alike, since every phase reaches the
// shell either way.

export type ChatLabel = {
  /** The chat's title as the sidebar shows it. */
  title: string
  /** The agent's name, when the chat has more than one and it is worth saying which. */
  agentName?: string
}

export type AgentNotifierDeps = {
  /** The environment whose chats these phases are: this desktop's. */
  environmentId: string
  mode: () => AgentNotificationMode
  isAnyWindowFocused: () => boolean
  /** The chat an event belongs to; null for one the sidebar does not list, which is never announced. */
  chatLabel: (workspaceId: string, agentId: string) => ChatLabel | null
  show: (notice: ShellNotice) => void
}

export type AgentNotifier = {
  onAgentPhase(event: AgentPhaseEvent): void
}

/** What a phase change says, or null when it says nothing worth a banner. */
export function agentNotice(
  event: AgentPhaseEvent,
  label: ChatLabel,
  mode: AgentNotificationMode,
  environmentId: string,
): ShellNotice | null {
  if (mode === 'off' || !event.workspaceId || !isAttentionEvent(event)) return null
  const who = label.agentName ?? null
  const body =
    event.phase === 'awaiting_input'
      ? who
        ? `${who} is waiting for you.`
        : 'Waiting for you.'
      : event.turnFailure
        ? who
          ? `${who} stopped with an error.`
          : 'Stopped with an error.'
        : who
          ? `${who} finished.`
          : 'Finished.'
  return {
    key: `chat:${event.workspaceId}\0${event.agentId}`,
    title: label.title,
    body,
    silent: mode !== 'banner-sound',
    activate: { kind: 'chat', environmentId, chatId: event.workspaceId, agentId: event.agentId },
  }
}

export function createAgentNotifier(deps: AgentNotifierDeps): AgentNotifier {
  return {
    onAgentPhase(event) {
      const mode = deps.mode()
      if (mode === 'off' || !event.workspaceId) return
      if (deps.isAnyWindowFocused()) return
      const label = deps.chatLabel(event.workspaceId, event.agentId)
      if (!label) return
      const notice = agentNotice(event, label, mode, deps.environmentId)
      if (notice) deps.show(notice)
    },
  }
}
