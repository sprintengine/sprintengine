import React from 'react'

import type { WorkspacePaneTab } from '../../../../../../shared/workspace'
import type { PublishedChatActivity } from '../../../panels/agentChat/chatActivityStore'
import { IconButton, Section, Tooltip, type TabItem } from '../../../ui'
import { paneKindDefinition } from '../paneKinds'
import { paneTabLabel } from '../paneTabItem'
import { PanelCard, PanelRow } from './PanelRow'
import { copy } from '../../../../../../shared/copy'

// What is open now: the pane's tabs, each with the marks the strip's tab wears
// (`paneTabItem`), and with what the strip's tab offered: pressed it comes
// forward, a middle click or its cross closes it, a right click opens the same
// menu. The tab the column would go Back to reads as current, which is also
// what Control-Tab starts from while the menu has the keyboard.
//
// A page the chat's agent drove, or a board it drew on, is listed too once its
// tab has gone, by the chat's own activity: pressing it opens one again.

export type OpenNowProps = {
  workspaceId: string
  tabs: WorkspacePaneTab[]
  /** Each tab as the strip draws it (`paneTabItem`). */
  items: TabItem[]
  /** The tab Back returns to. */
  currentTabId: string | null
  onOpenTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onTabContextMenu: (tabId: string, event: React.MouseEvent) => void
  /** The "+" that opens something else in the column. */
  addControl: React.ReactNode
}

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The plate a row leads with, in the place a live picture of the tab would stand. */
function Plate({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-control-md w-14 shrink-0 place-items-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-hover)] text-[color:var(--text-muted)]">
      {children}
    </span>
  )
}

function OpenTabRow({
  tab,
  item,
  current,
  onOpen,
  onClose,
  onContextMenu,
}: {
  tab: WorkspacePaneTab
  item: TabItem
  current: boolean
  onOpen: () => void
  onClose: () => void
  onContextMenu: (event: React.MouseEvent) => void
}) {
  const kindLabel = paneKindDefinition(tab.kind).label
  const label = paneTabLabel(tab)
  const detail = [label === kindLabel ? null : label, item.agent ? 'Agent using it' : null].filter(Boolean).join(' · ')
  return (
    <div
      className="group/open relative"
      data-control-tab-item=""
      data-open-now-tab={tab.id}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onClose()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event)
      }}
    >
      <PanelRow
        glyph={<Plate>{typeof item.icon === 'function' ? item.icon({ className: 'icon-sm' }) : item.icon}</Plate>}
        label={kindLabel}
        detail={detail || null}
        meta={item.count !== undefined ? <span className="tabular-nums">{item.count}</span> : null}
        onClick={onOpen}
        ariaLabel={item.ariaLabel ?? label}
        buttonProps={current ? { 'aria-current': 'true' } : undefined}
      />
      <span className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/open:opacity-100">
        <Tooltip content={item.closeLabel ?? copy.workspace.pane.panel.chatPanelOpenNow.close} placement="left">
          <IconButton
            size="xs"
            aria-label={item.closeLabel ?? copy.workspace.pane.panel.chatPanelOpenNow.close}
            onClick={onClose}
          >
            <CloseGlyph className="icon-xs" />
          </IconButton>
        </Tooltip>
      </span>
    </div>
  )
}

export function ChatPanelOpenNow({
  tabs,
  items,
  currentTabId,
  onOpenTab,
  onCloseTab,
  onTabContextMenu,
  addControl,
  activity,
}: OpenNowProps & { activity: PublishedChatActivity | null }) {
  const lapsed = (activity?.rows ?? []).filter(
    (row) => (row.kind === 'browser' || row.kind === 'canvas') && !tabs.some((tab) => tab.kind === row.kind),
  )
  const Row = lapsed.length + tabs.length > 0 ? PanelCard : React.Fragment
  return (
    <Section title={copy.workspace.pane.panel.chatPanelOpenNow.openNow} inset="flush" action={addControl}>
      <Row>
        {tabs.map((tab, index) => (
          <OpenTabRow
            key={tab.id}
            tab={tab}
            item={items[index]!}
            current={tab.id === currentTabId}
            onOpen={() => onOpenTab(tab.id)}
            onClose={() => onCloseTab(tab.id)}
            onContextMenu={(event) => onTabContextMenu(tab.id, event)}
          />
        ))}
        {lapsed.map((row) => {
          const { Glyph } = paneKindDefinition(row.kind)
          return (
            <PanelRow
              key={row.kind}
              glyph={
                <Plate>
                  <Glyph className="icon-sm" />
                </Plate>
              }
              label={row.label}
              detail={row.meta}
              onClick={() => activity?.open(row.kind)}
            />
          )
        })}
      </Row>
    </Section>
  )
}
