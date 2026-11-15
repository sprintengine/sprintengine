import { resolveSnoozePresets, type SnoozePresetId } from '../../../utils/workspaceSnooze'
import { ContextMenu, DescribedMenuItem, MenuDivider, MenuFlyoutItem, StarGlyph } from '../../ui'
import { copy } from '../../../../../shared/copy'

// The menu a right-click on a selection of several chats opens
// (sidebarBulkSelection.ts): the marks and rest a chat's own menu offers that
// mean the same for many at once. What only makes sense for one chat (Open,
// Rename, Reveal, New chat in project) is left to that chat's own menu.
//
// Each item says how many of the selection it reaches, since some chats in it
// may not take it: one still working is not settled or snoozed, one that is
// not a conversation has no title to regenerate.

export type BulkChatAction =
  'settle' | `snooze:${SnoozePresetId}` | 'regenerate-titles' | 'mark-unread' | 'star' | 'unstar'

/** How many of the selection each item reaches. */
export type BulkChatReach = {
  selected: number
  /** Not settled, and not working. */
  settle: number
  /** Awake, may sleep, and not working. */
  snooze: number
  regenerateTitle: number
  markUnread: number
  starred: number
}

function reachHint(reached: number, selected: number): string | undefined {
  return reached === selected ? undefined : `${reached} of ${selected}`
}

const chats = (count: number) => `${count} ${count === 1 ? 'chat' : 'chats'}`

export function BulkChatContextMenu({
  x,
  y,
  reach,
  onClose,
  onSelect,
}: {
  x: number
  y: number
  reach: BulkChatReach
  onClose: () => void
  onSelect: (action: BulkChatAction) => void
}) {
  const { selected } = reach
  const allStarred = reach.starred === selected
  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={copy.workspace.sidebar.bulkChatContextMenu.actionsFor(chats(selected))}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <DescribedMenuItem
        tooltip={`${allStarred ? copy.workspace.sidebar.bulkChatContextMenu.unstar : copy.workspace.sidebar.bulkChatContextMenu.star} ${chats(selected)}`}
        onClick={() => onSelect(allStarred ? 'unstar' : 'star')}
        icon={
          <StarGlyph
            filled={allStarred}
            stroked
            className={`icon-sm shrink-0 ${allStarred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {allStarred ? 'Unstar' : 'Star'}
      </DescribedMenuItem>
      <DescribedMenuItem
        disabled={reach.markUnread === 0}
        hint={reachHint(reach.markUnread, selected)}
        tooltip={copy.workspace.sidebar.bulkChatContextMenu.markFinishedChatsUnreadOn}
        onClick={() => onSelect('mark-unread')}
      >
        {copy.workspace.sidebar.bulkChatContextMenu.markUnread}
      </DescribedMenuItem>
      <DescribedMenuItem
        disabled={reach.regenerateTitle === 0}
        hint={reachHint(reach.regenerateTitle, selected)}
        tooltip={copy.workspace.sidebar.bulkChatContextMenu.retitleEachChatFromIts}
        onClick={() => onSelect('regenerate-titles')}
      >
        {copy.workspace.sidebar.bulkChatContextMenu.regenerateTitles}
      </DescribedMenuItem>
      <MenuDivider />
      <DescribedMenuItem
        disabled={reach.settle === 0}
        hint={reachHint(reach.settle, selected)}
        tooltip={copy.workspace.sidebar.bulkChatContextMenu.putAwayAndStopAgents}
        onClick={() => onSelect('settle')}
      >
        {copy.workspace.sidebar.bulkChatContextMenu.settle}
      </DescribedMenuItem>
      <MenuFlyoutItem
        label={copy.workspace.sidebar.bulkChatContextMenu.snooze}
        ariaLabel={copy.workspace.sidebar.bulkChatContextMenu.snooze2(chats(selected))}
        disabled={reach.snooze === 0}
        hint={reachHint(reach.snooze, selected)}
        tooltip={copy.workspace.sidebar.bulkChatContextMenu.hideUntilASetTime}
      >
        {resolveSnoozePresets(Date.now()).map((preset) => (
          <DescribedMenuItem
            key={preset.id}
            hint={preset.whenLabel}
            tooltip={copy.workspace.sidebar.bulkChatContextMenu.snoozeUntil(
              preset.label.toLowerCase(),
              preset.whenLabel,
            )}
            onClick={() => onSelect(`snooze:${preset.id}`)}
          >
            {preset.label}
          </DescribedMenuItem>
        ))}
      </MenuFlyoutItem>
    </ContextMenu>
  )
}
