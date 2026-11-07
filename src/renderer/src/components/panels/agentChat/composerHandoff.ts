import { isSubagentRecord } from '../../../../../shared/agent-state'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { composerDraftStore } from './draftStore'
import { mountedChatViewFor } from './mountedChatViews'
import { insertQuoteIntoDraft } from './quoteSelection'
import { readSubagentViews, subagentViewOwner } from './subagentViewStack'
import { readRemoteChats } from './remoteChatRegistry'

// A quote handed to a workspace's chat from somewhere else in the app (the
// diff viewer's "Add to chat", in this window or another): set into that
// chat's composer the way its own quote shortcut sets one.
//
// The chat drawn in this window takes it in its composer, at its caret, with
// the keyboard put there. One that is not drawn has it set into its saved
// draft, after whatever is there, and finds it when it is opened. Answers the
// agent that took it, or null when the workspace has no chat here.

/**
 * The chat in the workspace the quote should land in, among its agents a
 * conversation runs in: the one drawn here with the keyboard in it, else the
 * one drawn here, else the one the workspace last worked with
 * (`lastActiveAgentId`), else the first. A workspace with several chats is
 * rare, and the quote going to one the person is not looking at is the
 * mistake this order is there to avoid. A chat on a paired machine has no
 * record here, only the pane that holds it, and counts as one of them.
 */
function tabChatOf(workspaceId: string): string | null {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  const local = Object.entries(workspace?.agents ?? {})
    .filter(([, agent]) => agent.conversation && !isSubagentRecord(agent))
    .map(([agentId]) => agentId)
  const remote = readRemoteChats(workspaceId)
    .filter((entry) => !entry.subagentOf && !local.includes(entry.agentId))
    .map((entry) => entry.agentId)
  const chats = [...local, ...remote]
  if (chats.length <= 1) return chats[0] ?? null
  const drawn = chats.map((agentId) => mountedChatViewFor(workspaceId, agentId)).filter((view) => view !== null)
  const focused = drawn.find((view) => view.isFocused())
  if (focused?.agentId) return focused.agentId
  if (drawn[0]?.agentId) return drawn[0].agentId
  const last = workspace?.lastActiveAgentId
  if (last && chats.includes(last)) return last
  return chats[0]!
}

// The chat the person is looking at there: a sub-agent has no tab of its own to
// be found by, but when one is drawn in its parent's place the quote is for it,
// not for the parent hidden beneath it. A lane is part of the chat that holds it.
// A diff of one chat's own changes names that chat.
function chatAgentOf(workspaceId: string, named?: string): string | null {
  const tabChat = named ?? tabChatOf(workspaceId)
  const top = tabChat ? readSubagentViews(workspaceId, tabChat).at(-1) : undefined
  return top ? subagentViewOwner(top) : tabChat
}

export function deliverQuoteToWorkspaceChat(workspaceId: string, text: string, chatAgentId?: string): string | null {
  if (!text.trim()) return null
  const agentId = chatAgentOf(workspaceId, chatAgentId)
  if (!agentId) return null
  const view = mountedChatViewFor(workspaceId, agentId)
  if (view?.insertQuote) {
    view.insertQuote(text)
    return agentId
  }
  const drafts = composerDraftStore().getState()
  const draft = drafts.read(workspaceId, agentId)
  const next = insertQuoteIntoDraft(draft.text, text, draft.text.length)
  drafts.put(workspaceId, agentId, { ...draft, text: next.text })
  return agentId
}

/**
 * A workspace window's answer to the diff window's "Add to chat" (main's
 * `window:diff-to-chat`): take it when this window holds the workspace and
 * the workspace has a chat, bring that chat forward, and ack. Silence is the
 * refusal: main then asks the next window, and the diff window says nobody
 * took it when none does. The ack is the last thing, and only on the path
 * that set the quote into a composer.
 */
export function answerDiffToChat(
  request: { requestId: string; workspaceId: string; text: string },
  windowId: string,
  ack: (requestId: string) => void,
): boolean {
  const state = useWorkspaceStore.getState()
  if (!state.workspaces.some((workspace) => workspace.id === request.workspaceId)) return false
  // An unregistered window list (the single-window default) holds everything.
  const held = state.workspaceWindows.find((entry) => entry.id === windowId)?.workspaceIds
  if (held && !held.includes(request.workspaceId)) return false
  if (!deliverQuoteToWorkspaceChat(request.workspaceId, request.text)) return false
  state.setActiveWorkspaceForWindow(windowId, request.workspaceId)
  ack(request.requestId)
  return true
}
