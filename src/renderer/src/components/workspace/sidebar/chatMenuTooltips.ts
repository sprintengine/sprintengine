// What each item of a chat's right-click menu does, said on hover and on
// keyboard focus (owner request 2026-10-21: every item explains itself). One
// table for both menus, a chat here and a paired machine's, so the two say
// the same thing about the same item, and a new item is one more entry here.
//
// `where` says whose the chat is. A chat here is `local`. A paired machine's
// chat is `remote`, and `marks` says whether that machine keeps the row
// menu's star, colour, sleep and Auto-settle (`chat-lifecycle`): where it does
// they are written there, and where it does not a chat opened here keeps them
// on this computer only. An item that works differently on a remote chat says
// so in a few words; the menu is no place for a paragraph (owner ruling
// 2026-11-15).

import type { HighlightColor } from '../../../../../shared/workspace'
import { getHighlightSwatch } from '../../../utils/highlight'
import { hostPlatform } from '../../../clientCapabilities'
import type { MeshConversationManage } from '../../../../../shared/tailnet-mesh'

export type ChatMenuPlace =
  | { kind: 'local' }
  | {
      kind: 'remote'
      machineName: string
      marks: boolean
      /** What of the chat's management its machine takes from here; none when absent. */
      manage?: MeshConversationManage
    }

const LOCAL: ChatMenuPlace = { kind: 'local' }

/** Where a star or colour set from this menu is kept, for a paired machine's chat. */
function markKept(where: ChatMenuPlace): string {
  if (where.kind === 'local') return ''
  return where.marks ? ` (syncs to ${where.machineName})` : ' (this computer only)'
}

function fileManager(): string {
  const platform = hostPlatform()
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'Explorer'
  return 'your file manager'
}

export const chatMenuTooltips = {
  open: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local' ? 'Open this chat' : `Follow here; it runs on ${where.machineName}`,
  markUnread: (_where: ChatMenuPlace = LOCAL) => 'Mark latest reply unread on every device',
  rename: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local' || where.manage?.rename ? 'Rename this chat' : 'Rename on this computer only',
  regenerateTitle: () => 'Name it again from the first message',
  newChat: (projectless: boolean, where: ChatMenuPlace = LOCAL) =>
    projectless
      ? 'New chat with no project'
      : where.kind === 'remote'
        ? `New chat in this project on ${where.machineName}`
        : 'New chat in this project',
  reveal: () => `Show folder in ${fileManager()}`,
  /** Why Reveal folder is off: the folder is on another machine, or gone. */
  revealUnavailable: (where: ChatMenuPlace) =>
    where.kind === 'remote' ? `Folder is on ${where.machineName}` : 'Folder no longer exists',
  copyLink: (_where: ChatMenuPlace = LOCAL) => 'Copy a link to this chat',
  moveToNewWindow: (_where: ChatMenuPlace = LOCAL) => 'Open in its own window',
  moveToMainWindow: (_where: ChatMenuPlace = LOCAL) => 'Move back to the main window',
  star: (starred: boolean, where: ChatMenuPlace = LOCAL) =>
    (starred ? 'Unstar' : 'Pin to the top; never auto-settles') + markKept(where),
  stopWatching: (pullRequest: number, _where: ChatMenuPlace = LOCAL) => `Stop watching PR #${pullRequest}`,
  schedule: (paused: boolean) => (paused ? 'Resume the schedule' : 'Pause the schedule; this chat carries on'),
  settle: (working: boolean, _where: ChatMenuPlace = LOCAL) =>
    working ? 'Waits for the agents to finish' : 'Put away and stop its agents. A new message brings it back.',
  unsettle: () => 'Bring back to the list',
  snooze: (working: boolean, _where: ChatMenuPlace = LOCAL) =>
    working ? 'Waits for the agents to finish' : 'Hide until a time you pick; agents pause',
  snoozeUntil: (label: string, whenLabel: string) => `Until ${label.toLowerCase()}, ${whenLabel}`,
  wake: (_where: ChatMenuPlace = LOCAL) => 'Bring back to the list now',
  // Main's rest sweep (`shouldAutoSettleWorkspace`): its quiet days, counted
  // from a wake, held while a pull request is open; or its pull requests
  // merging; never a starred, snoozed, open, working or waiting chat. The
  // pull request halves are settings, both on by default.
  autoSettle: (_where: ChatMenuPlace = LOCAL, days = 3) =>
    `Settle after ${days === 1 ? 'a day' : `${days} days`} idle, or when its PRs merge`,
  // Studio's own compaction before a cache expires (conversation-auto-compact.ts):
  // idle, Claude only, at least 100k tokens, a minute or five before expiry.
  autoCompact: (claude: boolean, _where: ChatMenuPlace = LOCAL) =>
    claude ? 'Compact while idle, before the cache expires (100k+ tokens)' : 'Claude chats only',
  highlight: (color: HighlightColor | null, where: ChatMenuPlace = LOCAL) =>
    (color === null ? 'Remove highlight' : `Highlight ${getHighlightSwatch(color).label.toLowerCase()}`) +
    markKept(where),
  typeAction: (label: string) => label,
  // Settings ▸ Settled chats deletes the same way (useDeleteSettledChats).
  deleteSettled: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'remote'
      ? `Delete chat and history on ${where.machineName} for good`
      : 'Delete chat and history for good',
} as const
