import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { showToast } from '../../store/toastStore'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { Checkbox, EmptyState, GhostButton, Input, OutlineButton, Tooltip } from '../ui'
import { DangerButton } from '../ui/Buttons'
import { SettingCard, SettingToggle, SettingsPageHeader, SettingsRow } from './SettingsAtoms'
import { isImeKey } from '../../utils/imeKey'
import {
  MAX_AUTO_SETTLE_AFTER_DAYS,
  MIN_AUTO_SETTLE_AFTER_DAYS,
  normalizeAutoSettleAfterDays,
} from '../../utils/workspaceSettle'
import {
  bySettledAt,
  createSettledChatsSelector,
  environmentSettledChats,
  type SettledChatEntry,
} from './settledChatsModel'
import { isEnvironmentRecord, type RemoteSessionOpenSpec } from '../workspace/remoteBand/remoteSessionsModel'
import { useEnvironmentChatRows } from '../workspace/remoteBand/useEnvironmentChatRows'
import { useRemoteSessions } from '../workspace/remoteBand/useRemoteSessions'
import { useStableCallback } from '../../hooks/useStableCallback'
import { useDeleteSettledChats } from '../../hooks/useDeleteSettledChats'
import { settleEnvironmentChat } from '../../studio/environmentChatRecords'
import { copy } from '../../../../shared/copy'

const SETTLED_PAGE = 100

/**
 * Settings ▸ Settled chats (owner, 2026-09-28): where a chat goes once it has
 * come to rest. The sidebar used to fold these into a Settled shelf under
 * every project; that was one more line to read past for chats the person had
 * already called finished, so the rail stopped drawing them and this page
 * holds them instead.
 *
 * Three things to do with one: Open reads it (and, as opening any settled
 * chat does, leaves it settled — reading is not activity), Un-settle puts it
 * back in its project's list, and Delete is rid of it for good, with its
 * history and the worktree it owns (`useDeleteSettledChats`). Delete is a
 * button on the row, not hidden in a right-click menu, and the boxes beside
 * the rows delete many at once: a long-lived profile settles hundreds, and
 * clearing them one confirmation at a time is no way to do it. Select all
 * takes every settled chat, the ones folded under "Show more" included, and
 * the confirmation counts them.
 */
/**
 * How many quiet days settle a chat with Auto-settle on. Typed, and kept on
 * leaving the field or Enter; a blank entry goes back to what is kept, and an
 * out-of-range one to the nearest day in range.
 */
function AutoSettleDaysRow() {
  const days = normalizeAutoSettleAfterDays(useWorkspaceStore((s) => s.appSettings.autoSettleAfterDays))
  const setDays = useWorkspaceStore((s) => s.setAutoSettleAfterDays)
  const [draft, setDraft] = useState(String(days))
  useEffect(() => setDraft(String(days)), [days])
  const commit = () => {
    const parsed = draft.trim() === '' ? NaN : Number(draft)
    const next = Number.isFinite(parsed) ? normalizeAutoSettleAfterDays(parsed) : days
    setDays(next)
    setDraft(String(next))
  }
  return (
    <SettingsRow
      label={copy.settings.settledChatsSettingsTab.settleAfterQuietDays}
      help={copy.settings.settledChatsSettingsTab.appliesToChatsWithAutoSettle}
      htmlFor="auto-settle-after-days"
    >
      <Input
        id="auto-settle-after-days"
        type="number"
        inputMode="numeric"
        min={MIN_AUTO_SETTLE_AFTER_DAYS}
        max={MAX_AUTO_SETTLE_AFTER_DAYS}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isImeKey(event)) return
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        size="md"
        variant="well"
        fullWidth={false}
        className="w-20 text-right tabular-nums"
      />
    </SettingsRow>
  )
}

const quietDays = (days: number): string => (days === 1 ? 'a day' : `${days} days`)

export function SettledChatsSettingsTab({
  onOpenChat,
  onOpenEnvironmentChat,
}: {
  /** Leave Settings for this computer's chat. */
  onOpenChat: (id: string) => void
  /** Leave Settings for another environment's chat, opened where it is. */
  onOpenEnvironmentChat: (spec: RemoteSessionOpenSpec) => void
}): React.JSX.Element {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setWorkspaceSettled = useWorkspaceStore((s) => s.setWorkspaceSettled)
  const settleOnMerge = useWorkspaceStore((s) => s.appSettings.settleOnPullRequestMerge)
  const setSettleOnMerge = useWorkspaceStore((s) => s.setSettleOnPullRequestMerge)
  const keepWithOpenPr = useWorkspaceStore((s) => s.appSettings.keepChatsWithOpenPullRequest)
  const setKeepWithOpenPr = useWorkspaceStore((s) => s.setKeepChatsWithOpenPullRequest)
  const autoSettleDays = normalizeAutoSettleAfterDays(useWorkspaceStore((s) => s.appSettings.autoSettleAfterDays))
  const autoCompact = useWorkspaceStore((s) => s.appSettings.autoCompactChats)
  const setAutoCompact = useWorkspaceStore((s) => s.setAutoCompactChats)
  // One clock for the visit: "settled 3d ago" does not need to tick while the
  // page is open, and a timer here would re-render the list for nothing.
  const [now] = useState(() => Date.now())
  // The settled chats alone, not the whole registry: the list is the same
  // array until one of them moves, so a background agent's write elsewhere
  // re-renders nothing here.
  const [selectSettledChats] = useState(createSettledChatsSelector)
  const localChats = useWorkspaceStore((s) => selectSettledChats(s.workspaces, moduleOverrides))
  // Every other environment's settled chats, as it lists them; the records
  // here of its chats only say which one opening focuses.
  const records = useWorkspaceStore(useShallow((s) => s.workspaces.filter(isEnvironmentRecord)))
  const settledThere = useEnvironmentChatRows(records, moduleOverrides, true)
  const { refresh } = useRemoteSessions()
  const chats = useMemo(
    () => [...localChats, ...environmentSettledChats(settledThere)].sort(bySettledAt),
    [localChats, settledThere],
  )
  // Hundreds of chats settle on a long-lived profile; the page draws the most
  // recent and folds the rest.
  const [shown, setShown] = useState(SETTLED_PAGE)
  // Another environment's chat rests there: that environment is asked to
  // bring it back, so every device lists it again, and it leaves this list
  // once its list is read again.
  const unsettle = useCallback(
    (chat: SettledChatEntry) => {
      const where = chat.environment
      if (!where) {
        setWorkspaceSettled(chat.chatId, false)
        return
      }
      const refused = (message: string) =>
        showToast({
          tone: 'error',
          title: copy.settings.settledChatsSettingsTab.theChatWasNotBrought,
          description: message,
        })
      void settleEnvironmentChat({ route: where.route, name: where.machineName }, chat.chatId, false)
        .then((answer) => {
          if (answer.ok) refresh(where.route)
          else refused(answer.message)
        })
        .catch((error: unknown) => refused(error instanceof Error ? error.message : String(error)))
    },
    [setWorkspaceSettled, refresh],
  )
  const open = useStableCallback((chat: SettledChatEntry) =>
    chat.environment ? onOpenEnvironmentChat(chat.environment) : onOpenChat(chat.chatId),
  )
  const remaining = chats.length - shown
  const { deleteChats, deleting } = useDeleteSettledChats({ onDeletedThere: refresh })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // A chat that left the list (deleted, un-settled, deleted elsewhere) leaves the selection.
  const selectedChats = chats.filter((chat) => selected.has(chat.key))
  const allSelected = chats.length > 0 && selectedChats.length === chats.length
  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const remove = useCallback(
    async (targets: readonly SettledChatEntry[]) => {
      const gone = await deleteChats(targets)
      if (gone.length > 0) setSelected((current) => new Set([...current].filter((key) => !gone.includes(key))))
    },
    [deleteChats],
  )
  const removeOne = useCallback((chat: SettledChatEntry) => void remove([chat]), [remove])

  return (
    <div role="tabpanel" id="settings-panel-settled-chats" aria-labelledby="settings-tab-settled-chats">
      <SettingsPageHeader
        title={copy.settings.settledChatsSettingsTab.settledChats}
        meta={chats.length > 0 ? `${chats.length}` : undefined}
      />
      <SettingCard className="mb-5">
        <AutoSettleDaysRow />
        <SettingToggle
          label={copy.settings.settledChatsSettingsTab.settleWhenItsPullRequests}
          enabled={settleOnMerge}
          onChange={setSettleOnMerge}
        />
        <SettingToggle
          label={copy.settings.settledChatsSettingsTab.keepChatsWithAnOpen}
          enabled={keepWithOpenPr}
          onChange={setKeepWithOpenPr}
        />
        <SettingToggle
          label={copy.settings.settledChatsSettingsTab.autoCompactIdleChats}
          enabled={autoCompact}
          onChange={setAutoCompact}
        />
      </SettingCard>
      {chats.length === 0 ? (
        <EmptyState
          density="list"
          title={copy.settings.settledChatsSettingsTab.noSettledChats}
          body={copy.settings.settledChatsSettingsTab.settleAChatFromIts(quietDays(autoSettleDays))}
        />
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3 px-4">
            <Checkbox
              checked={allSelected}
              indeterminate={selectedChats.length > 0 && !allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(chats.map((chat) => chat.key)))}
              label={
                allSelected
                  ? copy.settings.settledChatsSettingsTab.allSelected(chats.length)
                  : copy.settings.settledChatsSettingsTab.selectAll
              }
            />
          </div>
          <SettingCard as="ul" ariaLabel={copy.settings.settledChatsSettingsTab.settledChats}>
            {chats.slice(0, shown).map((chat) => (
              <SettledChatRow
                key={chat.key}
                chat={chat}
                now={now}
                selected={selected.has(chat.key)}
                busy={deleting.has(chat.key)}
                onToggleSelected={toggleSelected}
                onUnsettle={unsettle}
                onOpen={open}
                onDelete={removeOne}
              />
            ))}
          </SettingCard>
        </>
      )}
      {remaining > 0 ? (
        <div className="mt-2 flex justify-center">
          <GhostButton size="xs" onClick={() => setShown((count) => count + SETTLED_PAGE)}>
            {copy.settings.settledChatsSettingsTab.show}
            {Math.min(SETTLED_PAGE, remaining)} more
          </GhostButton>
        </div>
      ) : null}
      {selectedChats.length > 0 ? (
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-[var(--radius-shell)] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-4 py-2.5">
          <span className="text-body font-medium text-[color:var(--text-strong)]">{selectedChats.length} selected</span>
          <span className="flex-1" />
          <GhostButton size="xs" onClick={() => setSelected(new Set())}>
            {copy.settings.settledChatsSettingsTab.clearSelection}
          </GhostButton>
          <Tooltip multiline content={copy.settings.settledChatsSettingsTab.deleteTheSelectedChatsAnd}>
            <DangerButton
              size="xs"
              disabled={selectedChats.some((chat) => deleting.has(chat.key))}
              onClick={() => void remove(selectedChats)}
            >
              {copy.settings.settledChatsSettingsTab.delete}
              {selectedChats.length === 1 ? '1 chat' : `${selectedChats.length} chats`}
            </DangerButton>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}

/** What a row's Delete says it does, on hover and keyboard focus. */
export function settledChatDeleteTooltip(machineName: string | null): string {
  return machineName
    ? `Deletes this chat and its history on ${machineName}, for every device that follows it. Its worktree there is removed or goes back to the pool unless it has uncommitted changes, and its branch is kept. You confirm first.`
    : 'Deletes this chat and its history for good. Its worktree is removed or goes back to the pool unless it has uncommitted changes, and its branch is kept. You confirm first.'
}

const SettledChatRow = React.memo(function SettledChatRow({
  chat,
  now,
  selected,
  busy,
  onToggleSelected,
  onUnsettle,
  onOpen,
  onDelete,
}: {
  chat: SettledChatEntry
  now: number
  selected: boolean
  /** Being deleted now. */
  busy: boolean
  onToggleSelected: (key: string) => void
  onUnsettle: (chat: SettledChatEntry) => void
  onOpen: (chat: SettledChatEntry) => void
  onDelete: (chat: SettledChatEntry) => void
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelected(chat.key)}
        ariaLabel={copy.settings.settledChatsSettingsTab.select(chat.title)}
        disabled={busy}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-[color:var(--text-strong)]" title={chat.title}>
          {chat.title}
        </div>
        <div className="truncate text-meta text-[color:var(--text-subtle)]">
          {chat.project}
          {copy.settings.settledChatsSettingsTab.settled}
          {formatRelativeMsAgo(chat.settledAt, now)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* The visible word leads the accessible name, and the chat
            follows it, so a list of these is not a list of identical
            buttons. */}
        <GhostButton
          size="xs"
          aria-label={copy.settings.settledChatsSettingsTab.unSettle(chat.title)}
          onClick={() => onUnsettle(chat)}
        >
          {copy.settings.settledChatsSettingsTab.unSettle2}
        </GhostButton>
        <OutlineButton
          size="xs"
          aria-label={copy.settings.settledChatsSettingsTab.open(chat.title)}
          onClick={() => onOpen(chat)}
        >
          {copy.settings.settledChatsSettingsTab.open2}
        </OutlineButton>
        <Tooltip multiline content={settledChatDeleteTooltip(chat.environment?.machineName ?? null)}>
          <GhostButton
            size="xs"
            tone="danger"
            busy={busy}
            disabled={busy}
            aria-label={`Delete ${chat.title}`}
            onClick={() => onDelete(chat)}
          >
            Delete
          </GhostButton>
        </Tooltip>
      </div>
    </li>
  )
})
