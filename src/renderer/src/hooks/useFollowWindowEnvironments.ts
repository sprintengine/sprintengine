import { useEffect } from 'react'

import { formatEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import { environmentTargetOf } from '../components/panels/agentChat/environmentChat'
import {
  environmentTargetsToFollow,
  followEnvironmentChats,
  knowEnvironments,
  withRecordedTargets,
  type FollowedEnvironment,
} from '../studio/environmentChats'
import { environmentStudioAvailable, type EnvironmentTarget } from '../studio/environmentStudio'
import { useWorkspaceStore, workspaceRegistryReady } from '../store/workspaceStore'
import { windowEnvironmentChatsCache } from '../studio/environmentChatsCache'
import { seedEnvironmentChatsOnce } from '../studio/environmentChatsSeed'
import type { Workspace } from '../../../shared/workspace'
import { currentEnvironments, useEnvironments } from './useEnvironments'

/** The environments this window keeps copies of chats of, each once, by the route the copy names. */
export function windowEnvironmentTargets(workspaces: readonly Pick<Workspace, 'environment'>[]): EnvironmentTarget[] {
  const targets = new Map<string, EnvironmentTarget>()
  for (const workspace of workspaces) {
    const target = environmentTargetOf(workspace.environment)
    if (target && !targets.has(target.route)) targets.set(target.route, target)
  }
  return [...targets.values()]
}

const keyOf = (targets: readonly FollowedEnvironment[]) =>
  targets.map((target) => `${target.route}\u0000${target.name}\u0000${target.resting ? 1 : 0}`).join('\u0001')

/**
 * Follow the chats of every environment the list holds (`environmentChats.ts`),
 * for as long as it holds them, and of every environment this window still
 * keeps a copy of a chat of (until those copies go): their sessions join the
 * window's one list, and each draws its last-known rows until it answers; an
 * environment that leaves the list loses them. A web tab, which reaches no
 * other environment, follows none.
 */
export function useFollowWindowEnvironments(): void {
  const recorded = useWorkspaceStore((state) =>
    windowEnvironmentTargets(state.workspaces)
      .map((target) => `${target.route}\u0000${target.name}`)
      .join('\u0001'),
  )
  const environments = useEnvironments()
  const listed = keyOf(environmentTargetsToFollow(environments))
  useEffect(() => {
    if (!environmentStudioAvailable()) return
    followEnvironmentChats(
      withRecordedTargets(
        environmentTargetsToFollow(currentEnvironments()),
        windowEnvironmentTargets(useWorkspaceStore.getState().workspaces),
      ),
    )
  }, [recorded, listed])
  // Which environment each route is, for the rows the window last read of it:
  // seeded once from the window's own records of their chats, then drawn.
  useEffect(() => {
    if (!environmentStudioAvailable() || environments.length === 0) return
    const routes = new Map<string, string>()
    const entries = environments.map((entry) => {
      const formatted = entry.routes.map((route) => formatEnvironmentRoute(route))
      if (entry.environmentId) for (const route of formatted) routes.set(route, entry.environmentId)
      return { environmentId: entry.environmentId, routes: formatted }
    })
    let current = true
    void seedEnvironmentChatsOnce({
      ready: workspaceRegistryReady,
      workspaces: () => useWorkspaceStore.getState().workspaces,
      idOfRoute: (route) => routes.get(route) ?? null,
      cache: windowEnvironmentChatsCache(),
    }).finally(() => {
      if (current) knowEnvironments(entries)
    })
    return () => {
      current = false
    }
  }, [environments])
  useEffect(() => () => followEnvironmentChats([]), [])
}
