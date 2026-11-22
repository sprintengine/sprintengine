// Which editor a file opens in: Studio's text editor, or a custom editor an
// extension declares for files of its type (`contributes.customEditors`).
//
// A file opens in the best-matching editor whose priority is `default` (an
// exact name beats a suffix, a longer suffix a shorter one); an `option`
// editor, or one matching a file Studio's text editor is for (`.ts`, `.json`,
// `.md` and their like), is only offered under Open with. Whatever opened it, the person can
// reopen the file in the text editor, or in another matching editor, and
// that choice holds for the file while this window is open. Every way of
// opening a file ends in the editor pane (the Files tree, `editor.open`, a
// link in a chat), so the choice is made there, once.

import type { ExtensionCustomEditorContribution } from '../../../../packages/extension-sdk/src/extension-manifest'
import {
  customEditorMatchRank,
  customEditorOpensByDefault,
  fileNameOf,
} from '../../../../packages/extension-sdk/src/custom-editors'
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
  const name = fileNameOf(path)
  return matches.find((editor) => customEditorOpensByDefault(editor.contribution, name)) ?? null
}

/** Tests only: forget every choice. */
export function resetEditorViewsForTests(): void {
  chosen.clear()
  version += 1
}
