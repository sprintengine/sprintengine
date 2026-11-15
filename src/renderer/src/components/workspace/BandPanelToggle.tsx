// The band's panel toggle, at the window's far right. The right-hand panel is
// the pane column, and the toggle opens it on its menu (`togglePaneMenu`).
//
// It steps aside while the column is docked open: the column's own strip ends
// in a close control with the same glyph, on the same line, in the same place at
// the window's edge. Closed, it is the way back in; maximised, or floating over
// a narrow window, the column sits below the band and drops its own close, and
// this one is the only one.

import { IconButton, Tooltip } from '../ui'
import { useNarrowViewport } from '../../hooks/useNarrowViewport'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { WorkspaceId } from '../../../../shared/workspace'
import { getEffectiveKeybindingLabel, platformKeybindingsFromApiPlatform } from '../../commands/effectiveKeybindings'

export function BandPanelToggle({ activeWorkspaceId }: { activeWorkspaceId: WorkspaceId | null }) {
  // Subscribed, so the control follows any path that opens or closes the column:
  // a click, the chord, a reveal from another surface.
  const paneOpen = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.paneState?.open ?? false,
  )
  const paneMaximised = useWorkspaceStore((state) => state.workspacePaneMaximised)
  const narrow = useNarrowViewport()
  const togglePaneMenu = useWorkspaceStore((state) => state.togglePaneMenu)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  if (!activeWorkspaceId || (paneOpen && !paneMaximised && !narrow)) return null
  const label = paneOpen ? 'Close panel' : 'Open panel'
  const shortcut = getEffectiveKeybindingLabel(
    'pane.toggle',
    keybindingSettings,
    platformKeybindingsFromApiPlatform(window.api.platform),
  )
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label} placement="bottom">
      {/* The kit's icon toggle. `pressed` is the neutral selection fill, and it
          supplies `aria-pressed` as `false` while off, which is what a toggle
          owes a screen reader. `app-no-drag` is the drag-region opt-out this
          control needs in the band. The column's own close control hands focus
          back here. */}
      <IconButton
        pressed={paneOpen}
        onClick={() => togglePaneMenu(activeWorkspaceId)}
        aria-label={label}
        className="app-no-drag"
        data-pane-switch=""
      >
        {/* SidebarChrome's collapse glyph mirrored: the same rect, the same 1.5
            stroke, the divider moved from x=6 to x=10. One idiom, both edges. */}
        <svg viewBox="0 0 16 16" fill="none" className="size-icon-sm" aria-hidden="true">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </Tooltip>
  )
}
