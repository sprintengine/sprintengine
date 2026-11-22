// Which custom editor opens a file, and the limits of the document a custom
// editor's frame is handed. Pure (no Node or DOM APIs): Studio's windows,
// the SDK's fakes and an author's tools read files the same way.

import type { ExtensionCustomEditorContribution } from './extension-manifest.js'

/**
 * The largest document a custom editor is handed or may hand back, text or
 * bytes: the most `files.read` answers and `files.write` writes.
 */
export const EXTENSION_EDITOR_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024

/** How long a save waits for the frame to hand over edits it is still holding (`studio.document` flush). */
export const EXTENSION_EDITOR_FLUSH_TIMEOUT_MS = 1_000

/**
 * How well `editor` matches a file named `fileName` (its last path segment):
 * 0 when it does not; an exact name beats any suffix, and a longer suffix
 * beats a shorter one. Case is ignored, and a file named only the suffix
 * (`.todo`) never matches it.
 */
export function customEditorMatchRank(
  editor: Pick<ExtensionCustomEditorContribution, 'extensions' | 'filenames'>,
  fileName: string,
): number {
  const name = fileName.toLowerCase()
  if (!name) return 0
  if ((editor.filenames ?? []).some((candidate) => candidate.toLowerCase() === name)) return 10_000
  let best = 0
  for (const suffix of editor.extensions ?? []) {
    const lower = suffix.toLowerCase()
    if (name.length > lower.length && name.endsWith(lower)) best = Math.max(best, lower.length)
  }
  return best
}

/** The last segment of a path, `/` or `\` between its parts. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? ''
}
