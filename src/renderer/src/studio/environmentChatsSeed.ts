import { formatEnvironmentRoute, isEnvironmentId } from '../../../../packages/studio-protocol/src/environment'
import { parseConversationWireHighlight } from '../../../../packages/conversation-protocol/src/public'
import type { MeshWorkspace, MeshWorkspaceRow } from '../../../shared/tailnet-mesh'
import type { Workspace } from '../../../shared/workspace'
import { isSettledWorkspace, workspaceLastUserMessageAt } from '../../../shared/workspace-lifecycle'
import { environmentTargetOf } from '../components/panels/agentChat/environmentChat'
import { remoteOriginChatWorkspaceId } from '../components/workspace/remoteBand/remoteSessionsModel'
import type { EnvironmentChatsCache } from './environmentChatsCache'

// The one-time seed of each environment's last-known rows from what this
// window still keeps of its chats: its copies of SSH and WSL chats and its
// records of paired chats opened here. Until those go (they are replaced by
// views by address), a machine that is away at the first start after rows
// moved onto its own list would otherwise show no chats at all until it
// answers. Each record becomes the row its machine's `workspaces.list` would
// give, filed under that machine's id; a machine that already has a list kept
// is left alone, and so is a route whose machine has never said its id.
//
// It runs once (`ENVIRONMENT_CHATS_SEEDED_KEY`), after the window's records
// have loaded. Deleted with the copies and records it reads.

/** Where the window notes that the seed has run. */
export const ENVIRONMENT_CHATS_SEEDED_KEY = 'sprintengine.environmentChats.seeded'

/** A record's row, as its own machine's list (`chat-rows`) would give it. */
function seedRowOf(workspace: Workspace, chatId: string, folderPath: string | null, now: number): MeshWorkspace {
  const highlight = parseConversationWireHighlight(workspace.highlight)
  const recencyAt = workspaceLastUserMessageAt(workspace)
  const epoch = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  const row: MeshWorkspaceRow = {
    ...(epoch(workspace.createdAt) ? { createdAt: workspace.createdAt } : {}),
    ...(epoch(recencyAt) ? { recencyAt } : {}),
    ...(epoch(workspace.lastUserMessageAt) ? { lastUserMessageAt: workspace.lastUserMessageAt } : {}),
    ...(epoch(workspace.lastTurnEndedAt) ? { lastTurnEndedAt: workspace.lastTurnEndedAt } : {}),
    ...(epoch(workspace.lastVisitedAt) ? { lastVisitedAt: workspace.lastVisitedAt } : {}),
    ...(epoch(workspace.visitRewoundAt) ? { visitRewoundAt: workspace.visitRewoundAt } : {}),
    ...(workspace.scheduledAgentId ? { scheduledAgentId: workspace.scheduledAgentId } : {}),
    ...(epoch(workspace.snoozedUntil) && workspace.snoozedUntil > now && !isSettledWorkspace(workspace)
      ? { snoozedUntil: workspace.snoozedUntil }
      : {}),
    ...(highlight ? { highlight } : {}),
    ...(workspace.autoSettleEnabled === true ? { autoSettle: true as const } : {}),
    ...(workspace.worktree
      ? {
          worktree: {
            branch: workspace.worktree.branch ?? null,
            ...(workspace.worktree.repoRoot ? { projectFolder: workspace.worktree.repoRoot } : {}),
          },
        }
      : {}),
  }
  return {
    id: chatId,
    name: workspace.name,
    mode: workspace.mode,
    folderPath,
    repository: null,
    settledAt: isSettledWorkspace(workspace) ? (workspace.settledAt ?? null) : null,
    row,
  }
}

/** Where a record's chat is: the route of the machine that holds it and its id there; null for this machine's own. */
function placeOf(workspace: Workspace): { route: string; chatId: string; folderPath: string | null } | null {
  const origin = workspace.remoteOrigin
  if (origin?.connectionId)
    return {
      route: formatEnvironmentRoute({ kind: 'tailnet', connection: origin.connectionId }),
      chatId: remoteOriginChatWorkspaceId(origin),
      folderPath: origin.workspaceRoot ?? null,
    }
  const target = environmentTargetOf(workspace.environment)
  return target ? { route: target.route, chatId: workspace.id, folderPath: workspace.folderPath } : null
}

/**
 * The rows each environment is seeded with, by its id: every copy and paired
 * record the window keeps whose route the list knows the id of. Exported for
 * its test.
 */
export function seedRowsOf(
  workspaces: readonly Workspace[],
  idOfRoute: (route: string) => string | null,
  now: number = Date.now(),
): Map<string, { route: string; workspaces: MeshWorkspace[] }> {
  const seeded = new Map<string, { route: string; workspaces: MeshWorkspace[] }>()
  for (const workspace of workspaces) {
    const place = placeOf(workspace)
    if (!place) continue
    const environmentId = idOfRoute(place.route)
    if (!environmentId || !isEnvironmentId(environmentId)) continue
    let entry = seeded.get(environmentId)
    if (!entry) seeded.set(environmentId, (entry = { route: place.route, workspaces: [] }))
    // Two records of one chat (a paired chat opened in two windows) are one row.
    if (entry.workspaces.some((row) => row.id === place.chatId)) continue
    entry.workspaces.push(seedRowOf(workspace, place.chatId, place.folderPath, now))
  }
  return seeded
}

/**
 * Seed each environment that has no list kept yet with the rows of the
 * window's records of its chats. Resolves once every write has landed; a
 * write that fails is skipped, its machine's own read fills it later.
 */
export async function seedEnvironmentChats(
  workspaces: readonly Workspace[],
  idOfRoute: (route: string) => string | null,
  cache: EnvironmentChatsCache,
): Promise<void> {
  const seeded = seedRowsOf(workspaces, idOfRoute)
  await Promise.all(
    [...seeded].map(async ([environmentId, { route, workspaces: rows }]) => {
      try {
        if ((await cache.load(environmentId)) !== null) return
        await cache.save(environmentId, {
          browse: {
            route,
            reachable: true,
            unreachableReason: null,
            unauthorized: false,
            workspaces: rows,
            gaps: [],
            takesFolder: false,
            grantScopes: [],
          },
        })
      } catch {
        // Its own read fills it.
      }
    }),
  )
}

let seeding: Promise<void> | null = null

/**
 * The seed, once on this desktop: after the window's records have loaded
 * (`ready`), and only once the list names some environment. A window whose
 * records have not loaded in time leaves it for the next list.
 */
export function seedEnvironmentChatsOnce(input: {
  ready: Promise<void>
  workspaces: () => readonly Workspace[]
  idOfRoute: (route: string) => string | null
  cache: EnvironmentChatsCache | null
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  waitMs?: number
}): Promise<void> {
  const storage =
    input.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : input.storage
  const { cache } = input
  if (!cache || !storage || storage.getItem(ENVIRONMENT_CHATS_SEEDED_KEY)) return Promise.resolve()
  if (seeding) return seeding
  const run = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const loaded = await Promise.race([
      input.ready.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), input.waitMs ?? 5_000)
      }),
    ]).finally(() => clearTimeout(timer))
    if (!loaded) return
    await seedEnvironmentChats(input.workspaces(), input.idOfRoute, cache)
    storage.setItem(ENVIRONMENT_CHATS_SEEDED_KEY, '1')
  })().finally(() => {
    seeding = null
  })
  seeding = run
  return run
}
