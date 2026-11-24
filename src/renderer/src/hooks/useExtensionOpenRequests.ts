import { useEffect, useRef } from 'react'

import type { ExtensionOpenOutcome } from '../../../shared/extension-open'
import type { ExtensionOpenWindowRequest } from '../../../shared/extension-open-ipc'
import { chooseEditorView, extensionEditorViewId, extensionEditorsFor } from '../modules/extension-editors'
import { planExtensionOpen } from '../modules/extension-open-plan'
import { getExtensionSurfacesOf } from '../modules/extension-surfaces'
import { useWorkspaceStore } from '../store/workspaceStore'
import { isOwnerTyping } from '../utils/agentEditorReveal'
import { openRevealedFile } from './useAgentEditorReveal'

// The window's half of `extension.open` (src/main/extension-open-broker.ts).
//
// Main asks the workspace windows one at a time; this window opens the
// extension's panel, or the file in its custom editor, in the workspace it
// shows, and says so, or says why not, so main can ask the next window. Like
// an agent's editor reveal, it never raises the window or takes the keyboard:
// a panel comes to the front of the pane, and a file opens behind the
// person's tab while they are typing in the editor.

/** Carry out one ask in this window, and say what came of it. */
function performExtensionOpen(
  request: ExtensionOpenWindowRequest,
  activeWorkspaceId: string | null,
): ExtensionOpenOutcome {
  const plan = planExtensionOpen(request, {
    activeWorkspaceId,
    panelsOf: (moduleId) =>
      getExtensionSurfacesOf('panels')
        .filter((surface) => surface.key === moduleId)
        .map((surface) => ({ id: surface.contribution.id, title: surface.contribution.title })),
    editorViewsFor: (file) => extensionEditorsFor(file).map(extensionEditorViewId),
  })
  if (plan.kind === 'refuse') return plan.outcome

  if (plan.kind === 'panel') {
    const opened = useWorkspaceStore.getState().openPaneTab(plan.workspaceId, {
      kind: 'extension',
      extension: { key: plan.moduleId, panel: plan.panel },
      title: plan.title,
    })
    if (!opened) {
      return {
        ok: false,
        code: 'not_found',
        message: 'The workspace this Studio window shows has no room for another tab: close one and try again.',
      }
    }
    return { ok: true, workspaceId: plan.workspaceId }
  }

  // The choice first, so the editor pane draws the file in the extension's
  // editor from its first frame rather than in the text editor.
  chooseEditorView(plan.workspaceId, plan.file, plan.viewId)
  void openRevealedFile(
    plan.workspaceId,
    { path: plan.file, displayPath: plan.file, name: plan.name, range: null },
    { background: isOwnerTyping(plan.workspaceId) },
  ).catch(() => undefined)
  return { ok: true, workspaceId: plan.workspaceId }
}

/** Mounted once per workspace window, with the workspace it shows. */
export function useExtensionOpenRequests(activeWorkspaceId: string | null): void {
  const activeRef = useRef(activeWorkspaceId)
  activeRef.current = activeWorkspaceId

  useEffect(() => {
    if (typeof window.api?.onExtensionOpenRequest !== 'function') return
    return window.api.onExtensionOpenRequest((request) => {
      let outcome: ExtensionOpenOutcome
      try {
        outcome = performExtensionOpen(request, activeRef.current)
      } catch (error) {
        // Answered either way: main waits on this window before asking the next.
        outcome = {
          ok: false,
          code: 'not_found',
          message: `This Studio window could not open it: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      window.api.ackExtensionOpen({ requestId: request.requestId, outcome })
    })
  }, [])
}
