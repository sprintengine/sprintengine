// How the sidebar files workspaces: folder groups, remote groups, the
// All chats shelves, and reordering within and between them.

import { type Workspace, type WorkspaceId } from '../../../../../shared/workspace'
import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import { type RemoteConversation } from '../remoteBand/remoteSessionsModel'
import { workspaceProjectRoot, workspaceProjectRootOf } from '../../../utils/workspaceWorktree'
import { shortMachineName } from '../../remote/machineRowModel'
import { isMeshConversationPane } from '../../../../../shared/tailnet-mesh'
import {
  isProjectlessChatsRoot,
  PROJECTLESS_CHATS_LABEL,
  projectlessScopeOf,
} from '../../../../../shared/projectless-chats'

export type FolderGroup = {
  key: string
  displayName: string
  fullPath: string | null
  missing: boolean
  workspaces: Workspace[]
  // A header for chats born on a paired machine (remote-sessions-ux /
  // new-chat-on-a-remote-machine): the machine plus the remote workspace's
  // root. Epic decision 6 puts project identity on the folder header, and a
  // remote row's project is on another machine — so the header names the
  // folder there, rather than filing the row under "No folder". Null for every
  // local group, AND for a remote project that has a local clone open here:
  // that one is the local header, which remote rows simply join.
  remote: {
    machineName: string
    workspaceRoot: string | null
    /**
     * Which repository the machine said the folder is. It is what this group's
     * hue is keyed on — a project is a repository (decision 3), so the same
     * repository wears one colour wherever it runs. Null when the machine could
     * not say, and then the group has no key and no hue: a path on another
     * disk must never key a colour, or one project ends up in two.
     */
    repository: RepositoryIdentity | null
  } | null
  /**
   * Other environments' chats in this project (owner, 2026-09-11), by
   * address: rows of it like any other, read off their environment's list.
   */
  remoteRows: RemoteConversation[]
  /**
   * …and the ones of them asleep on their machine, which this project's
   * Snoozed shelf holds beside its own, until each wakes. Absent where no
   * other environment's chat sleeps.
   */
  remoteSleepingRows?: RemoteConversation[]
}

export const NULL_FOLDER_KEY = '__no_folder__'

/**
 * The header facts a merged group takes from its local folder (the row that
 * founds the group may be the remote one, which has no folder of its own).
 */
export type LocalGroupHeader = { key: string; folderPath: string; missing: boolean }

export function resolveGroups(workspaces: readonly Workspace[]): {
  keys: Map<string, string>
  headers: Map<string, LocalGroupHeader>
  projectlessKey: string | null
} {
  const keys = new Map<string, string>()
  for (const workspace of workspaces) keys.set(workspace.id, groupKeyOf(workspace))
  // Each header's folder: the row that IS the folder, else the project a
  // worktree row was cut from, so a header founded by a worktree row still
  // names, reveals and creates into its project.
  const headers = new Map<string, LocalGroupHeader>()
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id)!
    const folderPath = workspace.folderPath?.trim()
    if (!folderPath || headers.has(key) || ownFolderKeyOf(workspace) !== key) continue
    headers.set(key, { key, folderPath, missing: workspace.folderMissing === true })
  }
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id)!
    if (headers.has(key)) continue
    const folderPath = workspaceProjectRoot(workspace)
    if (!folderPath) continue
    headers.set(key, { key, folderPath, missing: false })
  }
  return { keys, headers, projectlessKey: localProjectlessKey(workspaces) }
}

/** This window's own "No project" header, which other environments' projectless chats join. */
function localProjectlessKey(workspaces: readonly Workspace[]): string | null {
  for (const workspace of workspaces)
    if (isProjectlessChatsRoot(workspaceProjectRoot(workspace))) return groupKeyOf(workspace)
  return null
}

export function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

// A folder of nothing but whitespace is no folder at all, and has to be no
// folder to EVERY reader: `workspaceProjectRoot` already trims it away, so a
// key that kept it would file the row under a header spelled "   " while the
// project it hands to New chat is null.
export function folderKey(value: string | null): string {
  if (!value?.trim()) return NULL_FOLDER_KEY
  return normalizeFolder(value).toLowerCase()
}

export function folderDisplayName(value: string | null): string {
  if (!value?.trim()) return 'No folder'
  // The root every chat started without a project files under.
  if (isProjectlessChatsRoot(value)) return PROJECTLESS_CHATS_LABEL
  const normalized = normalizeFolder(value)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

/**
 * The header chats started without a project on other machines share when
 * this window has no "No project" header of its own for them to join.
 */
export const PROJECTLESS_GROUP_KEY = 'projectless'

/**
 * Which header one of this window's own chats files under: its project's
 * folder. A worktree-backed row files under the project it was cut from, not
 * under its own checkout: the person branched one project, they did not open a
 * second one, and a header named after the slug says otherwise. The row says
 * it is a worktree on its own line instead.
 */
export function groupKeyOf(workspace: Workspace): string {
  return folderKey(workspaceProjectRoot(workspace))
}

/**
 * Which header a chat files under, whichever environment it is on
 * (design-environments PR 3): one header per repository, however many
 * machines hold a clone of it (this window's own header of it when it has
 * one); otherwise one per folder on its environment, since the same path on
 * two machines is two folders; and one for every chat started without a
 * project. This window's own chats key by their folder alone, the keys their
 * headers have always had (`groupKeyOf`), which a repository's chats elsewhere
 * join through `byRepository`.
 */
export function projectKeyOf(
  project: {
    /** Its environment's id (or route, before the environment has said its id). */
    environmentId: string
    projectFolder: string | null
    repository: RepositoryIdentity | null
    projectless: boolean
  },
  local: {
    /** This window's own header of each repository it holds, by canonical key. */
    byRepository: ReadonlyMap<string, string>
    /** This window's own "No project" header, when it has one. */
    projectlessKey: string | null
  },
): string {
  if (project.projectless) return local.projectlessKey ?? PROJECTLESS_GROUP_KEY
  const canonicalKey = project.repository?.canonicalKey
  if (canonicalKey) return local.byRepository.get(canonicalKey) ?? `repository:${canonicalKey}`
  return `${project.environmentId}:${folderKey(project.projectFolder)}`
}

/**
 * The project a folder on another machine stands for: the folder, or the
 * checkout an app-made worktree there was cut from. All this side has of a
 * chat over there is its path, so the path is what is read: a pool slot or a
 * `chat-…` folder sits under `.sprintengine-worktrees/<project>/` on every
 * machine, and its folder name is a seat, not a project. Every name and key a
 * paired machine's chat files by comes through here, so that a row opened here
 * and one only listed cannot file differently. A worktree outside the container
 * is a checkout the person made and stays itself.
 */
export function remoteProjectFolder(workspaceRoot: string | null | undefined): string | null {
  return workspaceProjectRootOf({ folderPath: workspaceRoot })
}

/**
 * The key this row's own folder makes, before regrouping — the answer to
 * "did this row found its own group?", which `groupKeyOf` can no longer give
 * now that a worktree row is deliberately filed elsewhere.
 */
export function ownFolderKeyOf(workspace: Workspace): string {
  return folderKey(workspace.folderPath)
}

/**
 * Where "New chat in project" lands from this row, and null when there is
 * nowhere live to land it. The project is the header the row files under —
 * for a worktree row, the checkout it was cut from — so a worktree pruned
 * from under a chat does not take the action away: what went missing is the
 * worktree, not the project. Only a row whose target IS its own folder is
 * stopped by that folder being gone; a parent's own state is the header's to
 * report, and a header synthesized from a worktree never reports missing.
 */
export function newChatProjectTarget(workspace: Workspace): string | null {
  const own = workspace.folderPath?.trim()
  if (!own) return null
  const target = workspaceProjectRoot(workspace) ?? own
  if (folderKey(target) === ownFolderKeyOf(workspace)) return workspace.folderMissing ? null : target
  return target
}

/**
 * A remote-only project's header: the FOLDER's name on that machine, and
 * nothing else (owner, 2026-09-11).
 *
 * It used to read "mac-mini.example.ts.net · sprintengine" — the machine
 * first, the project second, so the same repository on two machines read as two
 * different projects and neither header lined up with the local one. The
 * machine is a glyph on each row now, with the device's name on hover, which is
 * where provenance belongs when the project is the thing being grouped.
 *
 * A worktree's folder is not the project's (`remoteProjectFolder`), so a chat
 * in the pool slot `demo-app-04` reads `demo-app` here as it does on its own
 * machine.
 *
 * `workspaceRoot` is the folder over there; `workspaceName` is a CHAT's name
 * and is never a header, which is the same reason the New-chat project chip
 * stopped offering chats as projects.
 */
export function remoteProjectName(workspaceRoot: string | null, machineName: string): string {
  // The machine, not "No folder", when the remote could not name a folder: a
  // chat over there IS somewhere, and a header spelled "No folder" would both
  // lie and collide with the local folderless group's name.
  if (!workspaceRoot?.trim()) return shortMachineName(machineName)
  if (projectlessScopeOf(workspaceRoot)) return PROJECTLESS_CHATS_LABEL
  return folderDisplayName(remoteProjectFolder(workspaceRoot))
}

export function buildFolderGroups(
  workspaces: Workspace[],
  keyOf: (workspace: Workspace) => string = groupKeyOf,
  headers: ReadonlyMap<string, LocalGroupHeader> = new Map(),
): FolderGroup[] {
  const groupOrder: string[] = []
  const groups = new Map<string, FolderGroup>()

  for (const workspace of workspaces) {
    const key = keyOf(workspace)
    if (!groups.has(key)) {
      groupOrder.push(key)
      // A row that is not itself the folder — a remote row filed under a
      // local one, a worktree filed under its project — never founds the
      // group with a header of its own: the header is the project's, read
      // off the header map whatever row happens to come first in the list.
      const merged = key !== ownFolderKeyOf(workspace) ? (headers.get(key) ?? null) : null
      // Trimmed for the same reason `folderKey` trims: whatever the key
      // called "no folder" must not reappear as a header path made of spaces.
      const folderPath = merged ? merged.folderPath : workspace.folderPath?.trim() || null
      groups.set(key, {
        key,
        displayName: folderDisplayName(folderPath),
        fullPath: folderPath,
        missing: merged ? merged.missing : workspace.folderMissing === true,
        workspaces: [],
        remote: null,
        remoteRows: [],
      })
    }
    const group = groups.get(key)!
    group.workspaces.push(workspace)
    // Only a row that IS the folder may report it gone. A pruned worktree is
    // its own folder's loss, not the project's, and painting the project
    // missing would also take away the header's New chat and Reveal.
    if (workspace.folderMissing && ownFolderKeyOf(workspace) === key) group.missing = true
  }

  return groupOrder.map((key) => groups.get(key)!)
}

export function reorderWithinFolder(
  workspaces: Workspace[],
  draggedId: WorkspaceId,
  targetId: WorkspaceId,
  position: 'before' | 'after',
): WorkspaceId[] {
  const next = [...workspaces]
  const draggedIdx = next.findIndex((w) => w.id === draggedId)
  if (draggedIdx === -1) return next.map((w) => w.id)
  const [dragged] = next.splice(draggedIdx, 1)
  let targetIdx = next.findIndex((w) => w.id === targetId)
  if (targetIdx === -1) {
    next.push(dragged)
  } else {
    if (position === 'after') targetIdx += 1
    next.splice(targetIdx, 0, dragged)
  }
  return next.map((w) => w.id)
}

export function reorderFolders(
  workspaces: Workspace[],
  draggedKey: string,
  targetKey: string,
  position: 'before' | 'after',
  keyOf: (workspace: Workspace) => string = groupKeyOf,
): WorkspaceId[] {
  const groups = buildFolderGroups(workspaces, keyOf)
  const draggedGroup = groups.find((g) => g.key === draggedKey)
  if (!draggedGroup) return workspaces.map((w) => w.id)
  const remaining = groups.filter((g) => g.key !== draggedKey)
  let targetIdx = remaining.findIndex((g) => g.key === targetKey)
  if (targetIdx === -1) {
    remaining.push(draggedGroup)
  } else {
    if (position === 'after') targetIdx += 1
    remaining.splice(targetIdx, 0, draggedGroup)
  }
  return remaining.flatMap((g) => g.workspaces.map((w) => w.id))
}

export function meshPanesOf(workspace: Workspace): Array<{ tabId: string; machineName: string; cli?: string }> {
  const panes: Array<{ tabId: string; machineName: string; cli?: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; id?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && isMeshConversationPane(record.component)) {
      const config = record.config as { machineName?: unknown; cli?: unknown; remoteSessionId?: unknown } | undefined
      const machine = config?.machineName
      if (typeof machine === 'string' && machine) {
        const tabId =
          typeof record.id === 'string' && record.id
            ? record.id
            : `mesh-conversation:${machine}:${String(config?.remoteSessionId ?? panes.length)}`
        panes.push({
          tabId,
          machineName: machine,
          ...(typeof config?.cli === 'string' && config.cli ? { cli: config.cli } : {}),
        })
      }
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  walk(model?.layout)
  if (Array.isArray(model?.borders)) for (const border of model.borders) walk(border)
  return panes
}
