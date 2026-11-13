import { useEffect } from 'react'

import { environmentTargetOf } from '../components/panels/agentChat/environmentChat'
import { followEnvironmentChats } from '../studio/environmentChats'
import { environmentStudioAvailable, type EnvironmentTarget } from '../studio/environmentStudio'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace } from '../types/workspace'

/** The environments a window's chats are on, other than its own Studio's, each once. */
export function windowEnvironmentTargets(workspaces: readonly Pick<Workspace, 'environment'>[]): EnvironmentTarget[] {
  const targets = new Map<string, EnvironmentTarget>()
  for (const workspace of workspaces) {
    const target = environmentTargetOf(workspace.environment)
    if (target && !targets.has(target.route)) targets.set(target.route, target)
  }
  return [...targets.values()]
}

/**
 * Follow the chats of every environment this window has chats on, for as long
 * as it has them (`environmentChats.ts`): their sessions join the window's
 * one list. A web tab, which reaches no other environment, follows none.
 */
export function useFollowWindowEnvironments(): void {
  const key = useWorkspaceStore((state) =>
    windowEnvironmentTargets(state.workspaces)
      .map((target) => `${target.route}\u0000${target.name}`)
      .join('\u0001'),
  )
  useEffect(() => {
    if (!environmentStudioAvailable()) return
    followEnvironmentChats(windowEnvironmentTargets(useWorkspaceStore.getState().workspaces))
  }, [key])
  useEffect(() => () => followEnvironmentChats([]), [])
}
