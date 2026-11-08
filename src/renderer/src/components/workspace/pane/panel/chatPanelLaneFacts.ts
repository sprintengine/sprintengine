import type { ChatPanelFacts } from '../../../panels/agentChat/chatPanelStore'
import type { SubagentFamilyLane } from '../../../panels/agentChat/subagentFamily'

/**
 * What the panel can say of a lane, from the chat holding it. A lane is a part
 * of that chat's transcript, with no record or session of its own, so nothing
 * that chat measures of itself is said of the lane. What stays is what they
 * truly share: where it runs, and the checkout and its pull requests. The chat's
 * changes and servers go, a preset it cannot set says whose it is, and what it
 * spent is its own number.
 */
export function laneFacts(
  chat: ChatPanelFacts,
  lane: SubagentFamilyLane | null,
  label: string | undefined,
): ChatPanelFacts {
  return {
    ...chat,
    name: lane?.name ?? label ?? 'Subagent',
    modelLabel: lane?.runsOn ?? null,
    changes: null,
    createPullRequest: null,
    localServers: null,
    permissions: null,
    permissionLabel: chat.permissionLabel ? 'Set by its parent' : null,
    tokens: lane?.tokens ?? null,
  }
}
