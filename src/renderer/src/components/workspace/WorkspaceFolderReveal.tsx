import React from 'react'

import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace } from '../../../../shared/workspace'
import { PANEL_COMMAND_EVENT } from '../../utils/panelCommands'
import { followedCheckoutOf } from './followedCheckout'
import { folderOpenTargetLabel } from './openInEditorTargets'

// The card that says the workspace folder could not be revealed. It exists
// only after a reveal has failed, which is never at first paint, so the card
// (and the lifecycle glyph and inline-notice shell it draws with) is fetched
// when a failure actually has to be shown.
const CursorErrorPopover = React.lazy(() =>
  import('../ui/CursorErrorPopover').then((m) => ({ default: m.CursorErrorPopover })),
)

/**
 * `Primary+O` (workspace.folder.reveal): reveal the followed checkout in the
 * file manager. The title bar used to carry an "Open in" control for this and
 * for external editors; it went (owner ruling 2026-11-02) and the shortcut
 * stayed, so it routes here rather than calling the IPC from the command,
 * keeping the folder it reveals the one the panel's Branch row names. A host
 * of no chrome of its own, mounted for as long as the window is: the shortcut
 * has no control to outlive.
 */
export function WorkspaceFolderReveal({
  activeWorkspace,
  activeWorkspaceId,
}: {
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
}): React.JSX.Element | null {
  const terminalSessions = useTerminalSessions()
  const focusedAgentId = useWorkspaceStore((state) =>
    activeWorkspaceId ? state.focusedAgentByWorkspaceId[activeWorkspaceId] : undefined,
  )
  // The followed agent's checkout, else the mounted worktree, else the project
  // root (`followedCheckoutOf`).
  const openPath = activeWorkspace
    ? (followedCheckoutOf(activeWorkspace, focusedAgentId, terminalSessions)?.probePath ?? '')
    : ''
  const [failure, setFailure] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!activeWorkspaceId) return
    const reveal = async () => {
      // No resolved checkout means there is nothing to reveal.
      if (!openPath) return
      const label = folderOpenTargetLabel('finder', window.api.platform === 'darwin')
      try {
        const result = await window.api.openFolderInTarget({ target: 'finder', path: openPath })
        if (!result.ok) setFailure(`Could not open ${label}: ${result.message}`)
      } catch (error) {
        // The channel itself failed, which is not one of the typed outcomes;
        // it still has to reach the person who pressed the keys.
        setFailure(`Could not open ${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id !== 'workspace.folder.reveal') return
      if (detail.workspaceId && detail.workspaceId !== activeWorkspaceId) return
      void reveal()
    }
    window.addEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
    return () => window.removeEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
  }, [openPath, activeWorkspaceId])

  if (!failure) return null
  // A shortcut has no control to anchor to, so the card sits under the window
  // band's centre.
  const anchor = { x: window.innerWidth / 2, y: 36 }
  return (
    <React.Suspense fallback={null}>
      <CursorErrorPopover key={failure} message={failure} anchor={anchor} onDismiss={() => setFailure(null)} />
    </React.Suspense>
  )
}
