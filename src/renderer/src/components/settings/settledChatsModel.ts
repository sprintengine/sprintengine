import type { Workspace } from '../../../../shared/workspace'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { isSettledWorkspace } from '../../utils/workspaceSettle'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { folderDisplayName, remoteProjectName } from '../workspace/sidebar/folderGroups'
import {
  isEnvironmentRecord,
  openSpecOfConversation,
  remoteConversationTitle,
  type RemoteConversation,
  type RemoteSessionOpenSpec,
} from '../workspace/remoteBand/remoteSessionsModel'

// Settings ▸ Settled chats reads the same rest the sidebar does (`settledAt`),
// where each chat is: this computer's chats from its records, every other
// environment's from what that environment lists (`environmentChatRows`'
// `settled`). There is no second store of old chats, only a second place to
// look at the ones there are.

export type SettledChatEntry = {
  /** Its key in the list: this computer's chat's id, or another environment's chat's address. */
  key: string
  /** Its id where it is. */
  chatId: string
  /** The row title the sidebar would have drawn. */
  title: string
  /** The project the sidebar would have filed it under. */
  project: string
  settledAt: number
  /**
   * The environment that holds it, when that is not this computer: what
   * opening, bringing back and deleting it ask there. Null for this
   * computer's own chat.
   */
  environment: RemoteSessionOpenSpec | null
}

/** One workspace's entry, or null when it is not a settled chat the rail would draw. */
function settledChatEntry(
  workspace: Workspace,
  moduleOverrides: ModuleEnablementOverrides | undefined,
): SettledChatEntry | null {
  // A record of another environment's chat is that environment's to list.
  if (!isSettledWorkspace(workspace) || isHiddenFromRail(workspace, moduleOverrides) || isEnvironmentRecord(workspace))
    return null
  return {
    key: workspace.id,
    chatId: workspace.id,
    title: remoteConversationTitle(workspace),
    project: folderDisplayName(workspace.folderPath),
    settledAt: workspace.settledAt as number,
    environment: null,
  }
}

export const bySettledAt = (a: SettledChatEntry, b: SettledChatEntry) => b.settledAt - a.settledAt

/** Another environment's settled chats (`environmentChatRows`' `settled` rows), as entries. */
export function environmentSettledChats(rows: readonly RemoteConversation[]): SettledChatEntry[] {
  return rows.flatMap((row) =>
    typeof row.settledAt === 'number'
      ? [
          {
            key: row.key,
            chatId: row.workspaceId,
            title: row.title,
            project: remoteProjectName(row.workspaceRoot, row.machineName),
            settledAt: row.settledAt,
            environment: openSpecOfConversation(row),
          },
        ]
      : [],
  )
}

/**
 * Every settled chat the rail would draw, most recently settled first: the
 * question someone opening this page is asking is "the one I put away the
 * other day", not "the oldest thing I own". Rail-hidden workspaces (a
 * module's own background residency) stay out here for the same reason they
 * are out of the rail — they were never chats.
 */
export function listSettledChats(
  workspaces: readonly Workspace[],
  moduleOverrides?: ModuleEnablementOverrides,
): SettledChatEntry[] {
  const entries: SettledChatEntry[] = []
  for (const workspace of workspaces) {
    const entry = settledChatEntry(workspace, moduleOverrides)
    if (entry) entries.push(entry)
  }
  return entries.sort(bySettledAt)
}

function entriesEqual(a: SettledChatEntry, b: SettledChatEntry): boolean {
  return a.key === b.key && a.title === b.title && a.project === b.project && a.settledAt === b.settledAt
}

/**
 * `listSettledChats` as a store selector for a page that stays open while the
 * store is written to (background agents write on every turn end). Each
 * workspace object is read once, each entry keeps its object while what it
 * says is unchanged, and the list itself is the previous array when no entry
 * moved, so a write to any other workspace re-renders nothing.
 */
export function createSettledChatsSelector(): (
  workspaces: readonly Workspace[],
  moduleOverrides?: ModuleEnablementOverrides,
) => SettledChatEntry[] {
  let readFor: ModuleEnablementOverrides | undefined
  let read = new WeakMap<Workspace, SettledChatEntry | null>()
  let previous: SettledChatEntry[] = []
  let previousById = new Map<string, SettledChatEntry>()
  return (workspaces, moduleOverrides) => {
    if (moduleOverrides !== readFor) {
      readFor = moduleOverrides
      read = new WeakMap()
    }
    const entries: SettledChatEntry[] = []
    for (const workspace of workspaces) {
      let entry = read.get(workspace)
      if (entry === undefined) {
        entry = settledChatEntry(workspace, moduleOverrides)
        const prior = entry ? previousById.get(entry.key) : undefined
        if (entry && prior && entriesEqual(prior, entry)) entry = prior
        read.set(workspace, entry)
      }
      if (entry) entries.push(entry)
    }
    entries.sort(bySettledAt)
    if (entries.length === previous.length && entries.every((entry, index) => entry === previous[index])) {
      return previous
    }
    previous = entries
    previousById = new Map(entries.map((entry) => [entry.key, entry]))
    return entries
  }
}
