import { useEffect } from 'react'

import { formatEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import type { EnvironmentEntry } from '../../../shared/environments'
import { environmentTargetOf } from '../components/panels/agentChat/environmentChat'
import { followEnvironmentChats } from '../studio/environmentChats'
import { environmentStudioAvailable, type EnvironmentTarget } from '../studio/environmentStudio'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { Workspace } from '../types/workspace'
import { currentEnvironments, useEnvironments } from './useEnvironments'

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
 * The route kinds whose chats this window follows without a record of them
 * here: a paired desktop's (`tailnet:`), and an SSH machine a paired desktop
 * relays (`relay:`). Their chats are listed by the machine itself.
 */
const FOLLOWED_WITHOUT_RECORDS: ReadonlySet<string> = new Set(['tailnet', 'relay'])

/** Every route of a kind the window follows without records, as the environment list names them. */
export function listedEnvironmentTargets(entries: readonly EnvironmentEntry[]): EnvironmentTarget[] {
  const targets = new Map<string, EnvironmentTarget>()
  for (const entry of entries)
    for (const route of entry.routes) {
      if (!FOLLOWED_WITHOUT_RECORDS.has(route.kind)) continue
      const formatted = formatEnvironmentRoute(route)
      if (!targets.has(formatted)) targets.set(formatted, { route: formatted, name: entry.displayName })
    }
  return [...targets.values()]
}

const keyOf = (targets: readonly EnvironmentTarget[]) =>
  targets.map((target) => `${target.route}\u0000${target.name}`).join('\u0001')

/**
 * Follow the chats of every environment this window has chats on, for as long
 * as it has them, and of every paired desktop and machine one relays, for as
 * long as the environment list holds them (`environmentChats.ts`): their
 * sessions join the window's one list. A web tab, which reaches no other
 * environment, follows none.
 */
export function useFollowWindowEnvironments(): void {
  const recorded = useWorkspaceStore((state) => keyOf(windowEnvironmentTargets(state.workspaces)))
  const listed = keyOf(listedEnvironmentTargets(useEnvironments()))
  useEffect(() => {
    if (!environmentStudioAvailable()) return
    followEnvironmentChats([
      ...windowEnvironmentTargets(useWorkspaceStore.getState().workspaces),
      ...listedEnvironmentTargets(currentEnvironments()),
    ])
  }, [recorded, listed])
  useEffect(() => () => followEnvironmentChats([]), [])
}
