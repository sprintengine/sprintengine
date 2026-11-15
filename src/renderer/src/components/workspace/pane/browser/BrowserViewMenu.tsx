import React from 'react'

import type { BrowserTabState } from '../../../../../../shared/browser'
import type { BrowserColorScheme } from '../../../../../../shared/browser-devices'
import { MenuItem, OverflowMenu, type OverflowMenuItem } from '../../../ui'
import { copy } from '../../../../../../shared/copy'

// The browser tab's ⋮ menu: the view actions that are not worth a glyph of
// their own. Rows are the shared menu vocabulary; the shortcut column carries
// only chords that work with the menu closed (the zoom chords do, from the
// guest or the toolbar).

type BrowserViewMenuProps = {
  state: BrowserTabState | null
  deviceToolbarOn: boolean
  onHardReload: () => void
  onOpenDevTools: () => void
  onOpenWindow: () => void
  onToggleDeviceToolbar: () => void
  /** Whether this tab is the floating player right now. */
  floating: boolean
  /** Absent where there is no workspace to float over (a pop-out window): the item is not offered. */
  onToggleFloating?: () => void
  onColorScheme: (scheme: BrowserColorScheme) => void
  onZoom: (direction: 1 | -1 | 0) => void
  onClearCookies: () => void
  onClearCache: () => void
}

const SCHEMES: { value: BrowserColorScheme; label: string }[] = [
  { value: 'system', label: copy.workspace.pane.browser.browserViewMenu.system },
  { value: 'light', label: copy.workspace.pane.browser.browserViewMenu.light },
  { value: 'dark', label: copy.workspace.pane.browser.browserViewMenu.dark },
]

function Tick() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BrowserViewMenu({
  state,
  deviceToolbarOn,
  onHardReload,
  onOpenDevTools,
  onOpenWindow,
  onToggleDeviceToolbar,
  floating,
  onToggleFloating,
  onColorScheme,
  onZoom,
  onClearCookies,
  onClearCache,
}: BrowserViewMenuProps) {
  const hasPage = Boolean(state?.url && state.url !== 'about:blank')
  const primary = window.api.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const zoomPercent = Math.round((state?.zoomFactor ?? 1) * 100)
  const scheme = state?.colorScheme ?? 'system'

  const items: OverflowMenuItem[] = [
    {
      id: 'hard-reload',
      label: copy.workspace.pane.browser.browserViewMenu.hardReload,
      onSelect: onHardReload,
      disabled: !hasPage,
    },
    {
      id: 'devtools',
      label: state?.devToolsOpen
        ? copy.workspace.pane.browser.browserViewMenu.focusDevTools
        : copy.workspace.pane.browser.browserViewMenu.openDevTools,
      onSelect: onOpenDevTools,
      disabled: !hasPage,
    },
    {
      id: 'window',
      label: copy.workspace.pane.browser.browserViewMenu.openSeparateWindow,
      onSelect: onOpenWindow,
      disabled: !hasPage,
    },
    ...(onToggleFloating
      ? [
          {
            id: 'float',
            // One item, two labels — the same control both ways, the way the
            // device toolbar's show/hide reads.
            label: floating
              ? copy.workspace.pane.browser.browserViewMenu.dockInPane
              : copy.workspace.pane.browser.browserViewMenu.floatOverWorkspace,
            onSelect: onToggleFloating,
          },
        ]
      : []),
    {
      id: 'device-toolbar',
      label: deviceToolbarOn
        ? copy.workspace.pane.browser.browserViewMenu.hideDeviceToolbar
        : copy.workspace.pane.browser.browserViewMenu.showDeviceToolbar,
      onSelect: onToggleDeviceToolbar,
    },
    {
      kind: 'flyout',
      id: 'appearance',
      label: copy.workspace.pane.browser.browserViewMenu.appearance,
      ariaLabel: copy.workspace.pane.browser.browserViewMenu.appearance,
      surfaceClassName: 'min-w-[140px]',
      render: (close) => (
        <>
          {SCHEMES.map((option) => (
            <MenuItem
              key={option.value}
              checked={scheme === option.value}
              selection="one-of"
              icon={
                scheme === option.value ? <Tick /> : <span className="inline-block size-[13px]" aria-hidden="true" />
              }
              onClick={() => {
                onColorScheme(option.value)
                close()
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </>
      ),
    },
    { kind: 'separator', id: 'zoom-separator' },
    {
      id: 'zoom-in',
      label: copy.workspace.pane.browser.browserViewMenu.zoomIn,
      shortcut: `${primary}=`,
      onSelect: () => onZoom(1),
    },
    {
      id: 'zoom-out',
      label: copy.workspace.pane.browser.browserViewMenu.zoomOut,
      shortcut: `${primary}-`,
      onSelect: () => onZoom(-1),
    },
    {
      id: 'zoom-reset',
      label: copy.workspace.pane.browser.browserViewMenu.resetZoom(zoomPercent),
      shortcut: `${primary}0`,
      onSelect: () => onZoom(0),
      disabled: zoomPercent === 100,
    },
    { kind: 'separator', id: 'storage-separator' },
    { id: 'clear-cookies', label: copy.workspace.pane.browser.browserViewMenu.clearCookies, onSelect: onClearCookies },
    { id: 'clear-cache', label: copy.workspace.pane.browser.browserViewMenu.clearCache, onSelect: onClearCache },
  ]

  return (
    <OverflowMenu
      ariaLabel={copy.workspace.pane.browser.browserViewMenu.browserView}
      triggerTooltip={copy.workspace.pane.browser.browserViewMenu.more}
      items={items}
    />
  )
}
