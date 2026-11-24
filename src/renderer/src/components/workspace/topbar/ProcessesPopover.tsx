import React from 'react'

import type { StudioAgentProcess, StudioBrowserTab } from '../../../../../../packages/studio-protocol/src/public'
import { CloseIconButton, EmptyState, IconButton, OutlineButton, PanelHeader, Tooltip, TruncatedText } from '../../ui'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { relativeFromNow } from '../../../utils/relativeTime'
import { formatBytes } from '../../settings/worktreesSettingsModel'
import { BrowserGlyph } from '../pane/paneKinds'
import { copy } from '../../../../../shared/copy'
import {
  chatLabel,
  durationWords,
  groupProcesses,
  portsWords,
  processStateWords,
  tabName,
  type KnownChat,
} from './processesModel'
import type { ProcessesView } from './useProcesses'

// What agents started on this window's machine and left running, opened from
// the account menu beside Sessions: the programs (a dev server, a headless
// browser, a report server), by the chat that started them, and the built-in
// browser's tabs, with whether each is making sound. Every row is stopped or
// closed by hand. "Left behind" says only that its agent has finished: some
// are kept running on purpose, so it reads in the row's ordinary ink, never as
// an error.

const words = copy.workspace.topbar.processesPopover

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function ProcessesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4.5" width="16" height="5.5" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
      <rect x="4" y="14" width="16" height="5.5" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.5 7.25H11M7.5 16.75H11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function ProgramGlyph({ kind, className }: { kind: StudioAgentProcess['kind']; className?: string }) {
  if (kind === 'browser') return <BrowserGlyph className={className} />
  return <ProcessesIcon className={className} />
}

const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-2.5 py-2 text-body text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]'
const GLYPH_PLATE =
  'flex size-control-xs shrink-0 items-center justify-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]'
const GROUP_HEADER = 'flex items-center gap-2 px-2.5 py-1.5 text-meta font-semibold text-[color:var(--text-subtle)]'

function ProcessRow({
  row,
  now,
  onStop,
}: {
  row: StudioAgentProcess
  now: number
  onStop: (row: StudioAgentProcess) => void
}) {
  const state = processStateWords(row.state)
  const parts = [
    row.ports.length > 0 ? portsWords(row.ports) : null,
    words.running(durationWords(now - row.startedAt)),
    formatBytes(row.memoryBytes),
    row.childCount > 0 ? words.moreProcesses(row.childCount) : null,
  ].filter((part): part is string => Boolean(part))
  const detail = [words.commandTooltip(row.pid, row.command), row.cwd ? words.inFolder(row.cwd) : null]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={ROW} data-process-row={row.id} data-process-state={row.state}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={GLYPH_PLATE}>
          <ProgramGlyph kind={row.kind} className="size-icon-md" />
        </span>
        <span className="min-w-0">
          <Tooltip content={detail} multiline wrapperClassName="block min-w-0">
            <span tabIndex={0} className="block min-w-0 rounded-xs focus-visible:focus-ring">
              <TruncatedText
                as="span"
                text={row.name}
                className="block min-w-0 font-medium text-[color:var(--text-strong)]"
              />
            </span>
          </Tooltip>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-micro text-[color:var(--text-subtle)]">
            <Tooltip content={state.hint} multiline>
              <span tabIndex={0} className="shrink-0 rounded-xs focus-visible:focus-ring">
                {state.word}
              </span>
            </Tooltip>
            <span aria-hidden="true">·</span>
            <TruncatedText as="span" text={parts.join(' · ')} className="min-w-0" />
          </span>
        </span>
      </div>
      <Tooltip content={words.stop}>
        <IconButton onClick={() => onStop(row)} aria-label={words.stopNamed(row.name)}>
          <StopIcon className="icon-sm" />
        </IconButton>
      </Tooltip>
    </div>
  )
}

function TabRow({
  tab,
  now,
  chats,
  onClose,
}: {
  tab: StudioBrowserTab
  now: number
  chats: ReadonlyMap<string, KnownChat>
  onClose: (tab: StudioBrowserTab) => void
}) {
  const name = tabName(tab)
  const parts = [
    tab.audible ? words.playingSound : null,
    tab.inView ? words.inView : null,
    chatLabel(tab.workspaceId, tab.agentIds[0], chats).label,
    words.open(durationWords(now - tab.openedAt)),
    words.usedAgo(durationWords(now - tab.lastUsedAt)),
    tab.closesAt !== undefined ? words.closes(relativeFromNow(tab.closesAt, now)) : null,
  ].filter((part): part is string => Boolean(part))
  return (
    <div className={ROW} data-browser-tab-row={tab.tabId} data-audible={tab.audible ? 'true' : 'false'}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={GLYPH_PLATE}>
          <BrowserGlyph className="size-icon-md" />
        </span>
        <span className="min-w-0">
          <Tooltip content={tab.url} multiline wrapperClassName="block min-w-0">
            <span tabIndex={0} className="block min-w-0 rounded-xs focus-visible:focus-ring">
              <TruncatedText
                as="span"
                text={name}
                className="block min-w-0 font-medium text-[color:var(--text-strong)]"
              />
            </span>
          </Tooltip>
          <TruncatedText
            as="span"
            text={parts.join(' · ')}
            className="mt-0.5 block text-micro text-[color:var(--text-subtle)]"
          />
        </span>
      </div>
      <Tooltip content={words.close}>
        <CloseIconButton onClick={() => onClose(tab)} aria-label={words.closeNamed(name)} />
      </Tooltip>
    </div>
  )
}

export function ProcessesPopover({
  view,
  chats,
  onStop,
  onCloseTab,
}: {
  view: ProcessesView
  chats: ReadonlyMap<string, KnownChat>
  onStop: (ids: readonly string[]) => Promise<{ notStopped: number }>
  onCloseTab: (tabId: string) => Promise<boolean>
}) {
  const now = useRelativeNow(30_000)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set())
  const groups = groupProcesses(
    view.processes.filter((row) => !busy.has(row.id)),
    chats,
  )
  const tabs = view.tabs.filter((tab) => !busy.has(tab.tabId))
  const leftBehind = view.processes.filter((row) => row.state === 'left-behind' && !busy.has(row.id))
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0) + tabs.length

  const hide = (ids: readonly string[]) => setBusy((current) => new Set([...current, ...ids]))
  const show = (ids: readonly string[]) => setBusy((current) => new Set([...current].filter((id) => !ids.includes(id))))
  const stop = async (ids: readonly string[]) => {
    hide(ids)
    setNotice(null)
    const { notStopped } = await onStop(ids)
    if (notStopped > 0) setNotice(words.couldNotStop(notStopped))
    show(ids)
  }
  const closeTab = async (tabId: string) => {
    hide([tabId])
    await onCloseTab(tabId)
    show([tabId])
  }

  const empty =
    view.unavailable === 'platform' ? (
      <EmptyState density="list" title={words.notOnWindows} body={words.notOnWindowsBody} />
    ) : view.unavailable === 'failed' && tabs.length === 0 ? (
      <EmptyState density="list" title={words.couldNotRead} body={words.couldNotReadBody} />
    ) : (
      <EmptyState density="list" title={words.nothingRunning} body={words.nothingRunningBody} />
    )

  return (
    <div className="w-[440px] overflow-hidden" data-processes-popover="true">
      <PanelHeader
        title={words.processes}
        count={total > 0 ? total : undefined}
        primaryAction={
          leftBehind.length > 1 ? (
            // Destructive stays ink: the outline's danger tone recolours the
            // label on hover and never fills the button with the error hue.
            <OutlineButton size="xs" tone="danger" onClick={() => void stop(leftBehind.map((row) => row.id))}>
              <StopIcon className="icon-xs" />
              {words.stopAllLeftBehind}
            </OutlineButton>
          ) : undefined
        }
      />
      {notice ? (
        <div role="status" className="px-3 pb-1 text-meta text-[color:var(--text-muted)]">
          {notice}
        </div>
      ) : null}
      {total === 0 ? (
        empty
      ) : (
        <div className="max-h-[480px] overflow-y-auto p-1">
          {tabs.length > 0 ? (
            <div className="py-1" data-processes-section="tabs">
              <div className={GROUP_HEADER}>{words.browserTabs}</div>
              <div className="space-y-1">
                {tabs.map((tab) => (
                  <TabRow
                    key={tab.tabId}
                    tab={tab}
                    now={now}
                    chats={chats}
                    onClose={(target) => void closeTab(target.tabId)}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {groups.length > 0 ? (
            <div className="py-1" data-processes-section="programs">
              {tabs.length > 0 ? <div className={GROUP_HEADER}>{words.programs}</div> : null}
              {groups.map((group) => (
                <div key={group.key} className="py-1">
                  <div className={GROUP_HEADER}>
                    <TruncatedText as="span" text={group.label} className="min-w-0" />
                    {group.leftBehind.length > 1 ? (
                      <OutlineButton
                        size="xs"
                        tone="danger"
                        className="ml-auto shrink-0"
                        onClick={() => void stop(group.leftBehind.map((row) => row.id))}
                        aria-label={words.stopAllLeftBehindIn(group.leftBehind.length, group.label)}
                      >
                        <StopIcon className="icon-xs" />
                        {words.stopAll}
                      </OutlineButton>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {group.rows.map((row) => (
                      <ProcessRow key={row.id} row={row} now={now} onStop={(target) => void stop([target.id])} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
