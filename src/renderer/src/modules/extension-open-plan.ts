// What a window does with an `extension.open` ask (useExtensionOpenRequests),
// decided apart from doing it so the rules are testable without a window: the
// server checked that the extension is installed and names what it asks for,
// but whether this window has it registered, and shows a workspace to open it
// in, only the window knows.

import type { ExtensionOpenOutcome, ExtensionOpenRequest } from '../../../shared/extension-open'

/** A panel this window has registered, as the plan needs it. */
export type PlannedPanel = { id: string; title: string }

export type ExtensionOpenContext = {
  /** The workspace this window shows, or null. */
  activeWorkspaceId: string | null
  /** The live panels of one extension in this window, in their order. */
  panelsOf: (moduleId: string) => readonly PlannedPanel[]
  /** The custom editor view ids (`<key>/<editor id>`) that open `file` here, best match first. */
  editorViewsFor: (file: string) => readonly string[]
}

export type ExtensionOpenPlan =
  | { kind: 'refuse'; outcome: Extract<ExtensionOpenOutcome, { ok: false }> }
  | { kind: 'panel'; workspaceId: string; moduleId: string; panel: string; title: string }
  | { kind: 'file'; workspaceId: string; file: string; name: string; viewId: string }

export function planExtensionOpen(request: ExtensionOpenRequest, context: ExtensionOpenContext): ExtensionOpenPlan {
  const workspaceId = context.activeWorkspaceId
  if (!workspaceId) {
    return refuse('no_workspace', 'This Studio window is not showing a workspace.')
  }
  const { moduleId } = request

  if (request.file !== undefined) {
    const views = context.editorViewsFor(request.file)
    const prefix = `${moduleId}/`
    // The server picks the editor when the extension has several; without
    // one, the extension's best match for the file is the one it means.
    const viewId = request.editor
      ? views.find((view) => view === `${prefix}${request.editor}`)
      : views.find((view) => view.startsWith(prefix))
    if (!viewId) {
      return refuse(
        'not_found',
        request.editor
          ? `The custom editor "${request.editor}" of ${moduleId} is not loaded in this Studio window, or does not open this file.`
          : `No custom editor of ${moduleId} is loaded in this Studio window for this file.`,
      )
    }
    return { kind: 'file', workspaceId, file: request.file, name: baseName(request.file), viewId }
  }

  const panels = context.panelsOf(moduleId)
  // Neither a panel nor a file named: the extension's first panel.
  const panel = request.panel ? panels.find((candidate) => candidate.id === request.panel) : panels[0]
  if (!panel) {
    return refuse(
      'not_found',
      request.panel
        ? `The panel "${request.panel}" of ${moduleId} is not loaded in this Studio window.`
        : `${moduleId} has no panel loaded in this Studio window.`,
    )
  }
  return { kind: 'panel', workspaceId, moduleId, panel: panel.id, title: request.title ?? panel.title }
}

function refuse(code: 'no_workspace' | 'not_found', message: string): ExtensionOpenPlan {
  return { kind: 'refuse', outcome: { ok: false, code, message } }
}

/** The file's name, on either separator: a Windows path arrives with backslashes. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}
