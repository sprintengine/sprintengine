import React from 'react'

import { useGitBranch } from '../../../../hooks/useGitBranch'
import { useTerminalSessions } from '../../../../hooks/useTerminalSessions'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import type { Workspace } from '../../../../../../shared/workspace'
import { displayBranchName } from '../../../../utils/branchLabel'
import { checkoutChangesOf, useCheckoutChangeSummary } from '../../checkoutChanges'
import { followedCheckoutOf } from '../../followedCheckout'
import { changedFilesPhrase } from '../../terminalLines'

// Where the workspace works when no chat is there to say: a terminal has no
// composer and publishes nothing, so the panel reads its checkout the way the
// sidebar's lines do. `followedCheckoutOf` is the rule, shared with the lines:
// the agent followed, else the mounted worktree, else the project root.

export type WorkspaceCheckoutFacts = {
  branch: string | null
  changes: { added: number; removed: number; phrase: string } | null
}

const SUMMARY_ID = 'chat-panel-checkout'

export function useWorkspaceCheckoutFacts(workspace: Workspace | null): WorkspaceCheckoutFacts {
  const terminalSessions = useTerminalSessions()
  const workspaceId = workspace?.id ?? null
  const focusedAgentId = useWorkspaceStore((state) =>
    workspaceId ? state.focusedAgentByWorkspaceId[workspaceId] : undefined,
  )
  const followed = workspace ? followedCheckoutOf(workspace, focusedAgentId, terminalSessions) : null
  const probePath = followed?.probePath ?? null
  const gitBranch = useGitBranch(probePath)
  const summary = useCheckoutChangeSummary(probePath, SUMMARY_ID)
  const followedAgentId = followed?.agent?.agentId ?? null
  const pullRequests = React.useMemo(
    () =>
      followedAgentId && workspaceId
        ? terminalSessions
            .filter((session) => session.workspaceId === workspaceId && session.agentId === followedAgentId)
            .flatMap((session) => session.pullRequests ?? [])
        : [],
    [terminalSessions, workspaceId, followedAgentId],
  )
  const { files, marks, hasCounts } = checkoutChangesOf(summary, pullRequests)
  const rawBranch = followed?.branch ?? gitBranch.branch
  const added = hasCounts ? (marks?.plus ?? 0) : 0
  const removed = hasCounts ? (marks?.minus ?? 0) : 0
  return {
    branch: rawBranch ? displayBranchName(rawBranch) : null,
    changes:
      hasCounts && files && (added > 0 || removed > 0) ? { added, removed, phrase: changedFilesPhrase(files) } : null,
  }
}
