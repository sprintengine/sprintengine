// `extension.open` (and `sprintengine-extension open`): show one of an
// installed extension's panels, or open a file in its custom editor, in a
// window of this machine's Studio. It never raises or focuses the window: the
// person sees it when they look. The server checks the extension and what it
// names; a window of this machine carries it out, in the workspace it shows.

/** What to show: a panel by its id (the first panel when neither is named), or a file in a custom editor. */
export type ExtensionOpenRequest = {
  /** The extension's install key. */
  moduleId: string
  /** A panel's id in extension.json. */
  panel?: string
  /** An absolute path to open in the extension's custom editor. */
  file?: string
  /** The custom editor's id, when the server picked one for `file`. */
  editor?: string
  /** The panel's or editor's title, for the tab. */
  title?: string
}

/** Why nothing was shown: no window here, no workspace on screen, or the window does not have it. */
export type ExtensionOpenRefusal = 'no_window' | 'no_workspace' | 'not_found'

export type ExtensionOpenOutcome =
  { ok: true; workspaceId: string } | { ok: false; code: ExtensionOpenRefusal; message: string }

/** A window of this machine shows it: the in-process shell's, or the shell's over the control channel. */
export type ExtensionOpener = (request: ExtensionOpenRequest) => Promise<ExtensionOpenOutcome>

/** Whether `value` is a request a window may act on. */
export function isExtensionOpenRequest(value: unknown): value is ExtensionOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const { moduleId, panel, file, editor, title } = value as Record<string, unknown>
  const optional = (field: unknown, max: number) =>
    field === undefined || (typeof field === 'string' && field.length > 0 && field.length <= max)
  return (
    typeof moduleId === 'string' &&
    moduleId.length > 0 &&
    moduleId.length <= 200 &&
    optional(panel, 200) &&
    optional(file, 4096) &&
    optional(editor, 200) &&
    optional(title, 200) &&
    (panel === undefined || file === undefined)
  )
}
