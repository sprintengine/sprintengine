import { parseConversationWireHighlight } from '../../../packages/conversation-protocol/src/serverFrames'
import type { StudioWorkspace } from '../../../packages/studio-protocol/src/public'
import { environmentRouteOfRecord } from '../../shared/environment-clients'
import { isMachinePath } from '../../shared/machine-paths'
import { projectFrecency, projectUsageKey, type ProjectUsageMap } from '../../shared/project-frecency'
import { projectColorKey, projectHue } from '../../shared/project-hue'
import type { RepositoryIdentity } from '../../shared/repository-identity'
import type { Workspace } from '../../shared/workspace'
import { isSettledWorkspace, workspaceLastUserMessageAt } from '../../shared/workspace-lifecycle'
import type { WorkspaceSyncSnapshot, WorkspaceSyncState } from '../../shared/workspace-sync'

// The chats this Studio holds, as a list: what `workspaces.list` answers on
// the protocol and the gateway's `workspace.list` tool answers on MCP, read
// from this Studio's own records (the registry, in its database). Every
// Studio serves it, with or without a desktop shell around it: an SSH
// machine's and a WSL distribution's list the chats they run, as a desktop
// lists its own. One implementation, so a device, a desktop browsing another
// machine and an agent read the same rows.

/** A listing: the chats, and the window arrangement a desktop's own agents may act on. */
export type StudioWorkspaceListing = {
  workspaces: StudioWorkspace[]
  activeWorkspaceId: string | null
  primaryWindowId: string | null
}

export type StudioWorkspaceList = {
  /**
   * The chats this Studio holds. `ownOnly` leaves out what another
   * environment holds (this desktop's copies of an SSH machine's or a WSL
   * distribution's chats, and a record still in such a machine's folder):
   * whoever asks from outside reaches those on that machine, not through here.
   */
  list(options: { ownOnly: boolean }): Promise<StudioWorkspaceListing>
}

export type StudioWorkspaceListDeps = {
  snapshot(): WorkspaceSyncSnapshot
  /** The repository a folder is a clone of (one-project-across-machines); cached by the reader, never throws. */
  readRepositoryIdentity(folderPath: string): Promise<RepositoryIdentity | null>
  /** Where chats were started, by project folder; absent, the rows go without the project's use. */
  projectUsage?(): ProjectUsageMap
  now?(): number
}

/** Whether a record is this Studio's own chat, and not one another environment holds. */
export function isThisMachinesChat(workspace: Workspace): boolean {
  return !environmentRouteOfRecord(workspace) && !isMachinePath(workspace.folderPath)
}

/** A record as the gateway's workspace tools and the list name it. */
export function workspaceRecordView(
  workspace: Workspace,
  windows: WorkspaceSyncState['workspaceWindows'],
): Record<string, unknown> & StudioWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    mode: workspace.mode,
    folderPath: workspace.folderPath ?? null,
    // The machine the folder is on, for a workspace on an SSH machine.
    ...(workspace.hostId ? { hostId: workspace.hostId } : {}),
    windowId: windows.find((windowState) => windowState.workspaceIds.includes(workspace.id))?.id ?? null,
    detail: 'full',
    agentIds: Object.keys(workspace.agents),
    // When the chat was settled, or null while it is in the list: a paired
    // desktop browsing this machine leaves the resting ones out, as this
    // machine's own sidebar does.
    settledAt: isSettledWorkspace(workspace) ? workspace.settledAt : null,
  }
}

/**
 * What the chat's row draws, beyond its name and folder (`chat-rows`): its
 * clocks, the row menu's marks, how it began and the worktree it works in.
 * Each is left out when there is nothing true to say, as a listed chat's are
 * (`conversation.list`), so a device lists the chats of a machine it cannot
 * reach from these rows alone, and a chat with no session there still has
 * its row.
 */
function chatRowOf(workspace: Workspace, at: number): Partial<StudioWorkspace> {
  const epoch = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
  const highlight = parseConversationWireHighlight(workspace.highlight)
  const scheduledAgentId = workspace.scheduledAgentId?.trim()
  const recencyAt = workspaceLastUserMessageAt(workspace)
  return {
    ...(epoch(workspace.createdAt) ? { createdAt: Math.trunc(workspace.createdAt) } : {}),
    ...(epoch(recencyAt) ? { recencyAt: Math.trunc(recencyAt) } : {}),
    ...(epoch(workspace.lastUserMessageAt) ? { lastUserMessageAt: Math.trunc(workspace.lastUserMessageAt) } : {}),
    ...(epoch(workspace.lastTurnEndedAt) ? { lastTurnEndedAt: Math.trunc(workspace.lastTurnEndedAt) } : {}),
    ...(epoch(workspace.lastVisitedAt) ? { lastVisitedAt: Math.trunc(workspace.lastVisitedAt) } : {}),
    ...(epoch(workspace.visitRewoundAt) ? { visitRewoundAt: Math.trunc(workspace.visitRewoundAt) } : {}),
    ...(scheduledAgentId ? { scheduledAgentId } : {}),
    // Only a snooze still ahead: one that has run out is a row awake.
    ...(epoch(workspace.snoozedUntil) && workspace.snoozedUntil > at && !isSettledWorkspace(workspace)
      ? { snoozedUntil: Math.trunc(workspace.snoozedUntil) }
      : {}),
    ...(highlight ? { highlight } : {}),
    ...(workspace.autoSettleEnabled === true ? { autoSettle: true as const } : {}),
    // A worktree chat files under the project it was cut from, as this machine's own sidebar files it.
    ...(workspace.worktree
      ? {
          worktree: {
            branch: workspace.worktree.branch ?? null,
            ...(workspace.worktree.repoRoot ? { projectFolder: workspace.worktree.repoRoot } : {}),
          },
        }
      : {}),
  }
}

/**
 * How much a row's project is used for new chats here, so a phone lists its
 * projects in the order New chat here does. Additive: a phone that finds them
 * absent (an older desktop) orders by its own picks.
 *
 * - `projectFrecency`: the project's score as of this listing, 0 for a project
 *   never used. Every row of one listing is scored at the same moment, so they
 *   compare. Keyed by the row's own folder, which is what a phone lists a
 *   project by: a worktree chat's folder is its own entry there.
 * - `projectLastUsedAt`: the latest use as an ISO time, null for never; a tie
 *   on the score goes to the later one.
 */
function projectUseFields(
  workspace: Workspace,
  usage: ProjectUsageMap,
  now: number,
): { projectFrecency: number; projectLastUsedAt: string | null } {
  const key = projectUsageKey(workspace.folderPath)
  const entry = key ? usage[key] : undefined
  return {
    // Six places are plenty to order by and keep the float noise off the wire.
    projectFrecency: Math.round(projectFrecency(entry, now) * 1e6) / 1e6,
    projectLastUsedAt: entry ? new Date(entry.lastUsedAt).toISOString() : null,
  }
}

export function createStudioWorkspaceList(deps: StudioWorkspaceListDeps): StudioWorkspaceList {
  return {
    async list({ ownOnly }) {
      const { state } = deps.snapshot()
      const usage = deps.projectUsage?.() ?? null
      const listedAt = deps.now?.() ?? Date.now()
      const listed = ownOnly ? state.workspaces.filter(isThisMachinesChat) : state.workspaces
      const workspaces = await Promise.all(
        listed.map(async (workspace): Promise<StudioWorkspace> => {
          // The repository each folder is a clone of rides the listing
          // (one-project-across-machines): it is how a paired Studio
          // recognises its own project on this machine.
          const repository = workspace.folderPath ? await deps.readRepositoryIdentity(workspace.folderPath) : null
          const colorKey = projectColorKey({ folderPath: workspace.folderPath ?? null, repository })
          return {
            ...workspaceRecordView(workspace, state.workspaceWindows),
            ...chatRowOf(workspace, listedAt),
            repository,
            // The project's hue, as `terminal.list` sends it: derived here so a
            // phone paints the degree the sidebar does; null for no folder.
            projectHue: colorKey ? projectHue(colorKey) : null,
            ...(usage ? projectUseFields(workspace, usage, listedAt) : {}),
          }
        }),
      )
      return {
        workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        primaryWindowId: state.primaryWorkspaceWindowId,
      }
    },
  }
}
