import type { Workspace } from '../../../../shared/workspace'
import { isSettledWorkspace } from '../../utils/workspaceSettle'
import { isEnvironmentRecord } from './remoteBand/remoteSessionsModel'

// What `chat.settle` does to the chat on screen, the same toggle as Settle in
// the row's menu: a settled chat comes back; one whose agents are working is
// left alone, because settling ends their processes and whatever they were
// doing with them; this window's record of another environment's chat (a
// copy, a chat attached here) is settled there; any other chat settles here.
export type ChatSettleStep = 'restore' | 'busy' | 'settle-remote' | 'settle'

export function chatSettleStep(
  workspace: Pick<Workspace, 'settledAt' | 'remoteOrigin' | 'environment'>,
  working: boolean,
): ChatSettleStep {
  if (isSettledWorkspace(workspace)) return 'restore'
  if (working) return 'busy'
  return isEnvironmentRecord(workspace) ? 'settle-remote' : 'settle'
}
