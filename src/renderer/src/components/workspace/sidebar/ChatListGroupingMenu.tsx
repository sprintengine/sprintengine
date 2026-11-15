import React from 'react'

import { FilterMenu, Tooltip } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectChatListView, type ChatListView } from '../../../store/slices/settingsSlice'
import { copy } from '../../../../../shared/copy'

const CHAT_LIST_VIEW_ITEMS: ReadonlyArray<{ value: ChatListView; label: string }> = [
  { value: 'projects', label: copy.workspace.sidebar.chatListGroupingMenu.byProject },
  { value: 'status', label: copy.workspace.sidebar.chatListGroupingMenu.byStatus },
  { value: 'date', label: copy.workspace.sidebar.chatListGroupingMenu.byDate },
  { value: 'all', label: copy.workspace.sidebar.chatListGroupingMenu.allChats },
]

/**
 * How this window groups its chats: by project, by status, by the day the
 * person last wrote to each, or all together (owner requests 2026-11-02 and
 * 2026-11-10). It sits on New chat's row beside the scheduled
 * clock. The pick is this window's and lasts until it closes; Settings ▸
 * Appearance sets the shape every window opens in. The glyph tints while the
 * window is off that default, so a list grouped another way never passes for
 * the usual one.
 *
 * Its own component, reading the store itself, so the sidebar's every render
 * (a chat switch, an agent's tick) does not re-render the menu with it.
 */
export const ChatListGroupingMenu = React.memo(function ChatListGroupingMenu() {
  const view = useWorkspaceStore(selectChatListView)
  const defaultView = useWorkspaceStore((s) => s.chatListView)
  const setOverride = useWorkspaceStore((s) => s.setChatListViewOverride)
  return (
    <Tooltip content={copy.workspace.sidebar.chatListGroupingMenu.groupChats} placement="right">
      <FilterMenu
        ariaLabel={copy.workspace.sidebar.chatListGroupingMenu.groupChats}
        size="md"
        className="shrink-0"
        groups={[
          {
            label: copy.workspace.sidebar.chatListGroupingMenu.groupChats,
            items: CHAT_LIST_VIEW_ITEMS,
            value: view,
            defaultValue: defaultView,
            onChange: (value) => setOverride(value as ChatListView),
          },
        ]}
      />
    </Tooltip>
  )
})
