// Which editor a file opens in: Studio's text editor, or a custom editor an
// extension declares for files of its type (`contributes.customEditors`).
//
// A file opens in the best-matching editor whose priority is `default` (an
// exact name beats a suffix, a longer suffix a shorter one); an `option`
// editor is only offered under Open with, and so is every editor for a file
// Studio's own editor already has a language for, or shows as an image, by
// the same registry it highlights with (`textEditorHandles`), whether the
// editor names the file by suffix or by name. Installing an extension never
// changes how a person's code opens. Whatever opened it, the person can
// reopen the file in the text editor, or in another matching editor, and
// that choice holds for the file while this window is open. Every way of
// opening a file ends in the editor pane (the Files tree, `editor.open`, a
// link in a chat), so the choice is made there, once.

import type { ExtensionCustomEditorContribution } from '../../../../packages/extension-sdk/src/extension-manifest'
import { customEditorMatchRank, fileNameOf } from '../../../../packages/extension-sdk/src/custom-editors'
import { textEditorHandles } from '../utils/files'
import { getExtensionSurfacesOf, type LoadedExtensionSurface } from './extension-surfaces'

/** A custom editor that matches a file, with the extension it comes from. */
export type MatchedExtensionEditor = LoadedExtensionSurface & { contribution: ExtensionCustomEditorContribution }

/** The view a file is shown in: the text editor, or a custom editor by its view id. */
export const TEXT_EDITOR_VIEW = 'text'

/** A custom editor's view id: its extension's install key and its id. */
export function extensionEditorViewId(editor: Pick<LoadedExtensionSurface, 'key' | 'contribution'>): string {
  return `${editor.key}/${editor.contribution.id}`
}

/** The custom editors that open `path`, best match first. */
export function extensionEditorsFor(path: string): MatchedExtensionEditor[] {
  const name = fileNameOf(path)
  return (getExtensionSurfacesOf('customEditors') as MatchedExtensionEditor[])
    .map((editor) => ({ editor, rank: customEditorMatchRank(editor.contribution, name) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.editor)
}

// The person's choice per file, for as long as the window is open.
const chosen = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

const choiceKey = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`

/** Show `path` in `view` (TEXT_EDITOR_VIEW or a custom editor's view id). */
export function chooseEditorView(workspaceId: string, path: string, view: string): void {
  chosen.set(choiceKey(workspaceId, path), view)
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribeEditorViews(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A number that moves whenever a choice changes. */
export function editorViewsVersion(): number {
  return version
}

/**
 * The custom editor `path` is shown in, or null for the text editor: the
 * person's choice while it still matches, else the best `default` match.
 */
export function resolveExtensionEditor(
  workspaceId: string,
  path: string,
  matches: readonly MatchedExtensionEditor[],
): MatchedExtensionEditor | null {
  const choice = chosen.get(choiceKey(workspaceId, path))
  if (choice === TEXT_EDITOR_VIEW) return null
  const picked = choice ? matches.find((editor) => extensionEditorViewId(editor) === choice) : undefined
  if (picked) return picked
  return matches.find((editor) => opensByDefault(editor, path)) ?? null
}

/** Whether `editor` takes `path` when it is opened, rather than being offered. */
function opensByDefault(editor: MatchedExtensionEditor, path: string): boolean {
  if ((editor.contribution.priority ?? 'default') !== 'default') return false
  // A language the extension contributes itself does not stand in its own editor's way.
  return !textEditorHandles(fileNameOf(path), editor.key)
}

// ── Leaving an editor ───────────────────────────────────────────────────────
// The custom editor open on a file answers whether the person may leave it
// now (extension-editor-controller.ts): Open with…, closing the tab and
// drawing the frame again all ask first.

export type EditorLeaveGuard = (
  where: 'text-editor' | 'other-editor' | 'close',
  nextKind?: 'text' | 'bytes',
) => Promise<boolean>

const guards = new Map<string, EditorLeaveGuard>()

/** The custom editor shown for `path` says what leaving it takes; returns the way to stop. */
export function registerEditorLeaveGuard(workspaceId: string, path: string, guard: EditorLeaveGuard): () => void {
  const key = choiceKey(workspaceId, path)
  guards.set(key, guard)
  return () => {
    if (guards.get(key) === guard) guards.delete(key)
  }
}

/** Whether a custom editor is shown for `path`, and must be asked before it goes. */
export function hasEditorLeaveGuard(workspaceId: string, path: string): boolean {
  return guards.has(choiceKey(workspaceId, path))
}

/** True when the person may leave `path`'s custom editor for `where` now; true too when none is shown. */
export function leaveExtensionEditor(
  workspaceId: string,
  path: string,
  where: 'text-editor' | 'other-editor' | 'close',
  nextKind?: 'text' | 'bytes',
): Promise<boolean> {
  const guard = guards.get(choiceKey(workspaceId, path))
  return guard ? guard(where, nextKind) : Promise.resolve(true)
}

/**
 * Close a file tab only once the custom editor shown for it, if any, let it
 * go: true when the editor takes over (and runs `close` itself if it may),
 * false when there is none and the caller closes as usual.
 */
export function guardsExtensionEditorClose(
  workspaceId: string,
  node: { getComponent(): string | undefined; getConfig(): unknown },
  close: () => void,
): boolean {
  if (node.getComponent() !== 'file-editor') return false
  const path = (node.getConfig() as { filePath?: unknown } | undefined)?.filePath
  if (typeof path !== 'string' || !hasEditorLeaveGuard(workspaceId, path)) return false
  void leaveExtensionEditor(workspaceId, path, 'close').then((ok) => {
    if (ok) close()
  })
  return true
}

/** Tests only: forget every choice. */
export function resetEditorViewsForTests(): void {
  chosen.clear()
  version += 1
}
