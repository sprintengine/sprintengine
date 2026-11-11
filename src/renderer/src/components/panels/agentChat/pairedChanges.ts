import { openDiffTab } from '../../workspace/pane/popout/panePopOutHost'
import { readRemoteChat, useRemoteChat, type RemoteChatEntry } from './remoteChatRegistry'

// Changes, for a chat on a paired machine: its changes are that machine's
// checkout's, read from there into the Diff tab here, where the machine reads
// them (`conversation-changes`). A machine that does not keeps the row as the
// count it was, opening nothing.

/** The open chat that answers for `agentId` on a paired machine that reads its changes, or null. */
function pairedEntry(entry: RemoteChatEntry | null, agentId: string): RemoteChatEntry | null {
  if (!entry?.hostChanges) return null
  // A sub-agent is a chat of its own over there, in its parent's machine.
  return entry.agentId === agentId || entry.subagents.some((subagent) => subagent.agentId === agentId) ? entry : null
}

/** Whether Changes for this chat opens its changes from its paired machine; null for a chat here. */
export function usePairedChanges(workspaceId: string, agentId: string | null): RemoteChatEntry | null {
  const entry = useRemoteChat(workspaceId, agentId)
  return agentId ? pairedEntry(entry, agentId) : null
}

/** The Diff tab on a paired chat's changes, opened, or false when the chat is not one whose changes can be. */
export function openPairedChanges(workspaceId: string, agentId: string): boolean {
  const entry = pairedEntry(readRemoteChat(workspaceId, agentId), agentId)
  if (!entry) return false
  openDiffTab(workspaceId, {
    diff: {
      focusPath: null,
      focusKind: null,
      paired: { ...entry.key, agentId, machineName: entry.machineName },
    },
  })
  return true
}
