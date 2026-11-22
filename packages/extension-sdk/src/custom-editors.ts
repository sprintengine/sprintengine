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

/**
 * Suffixes of files Studio's own text editor is for: source, configuration,
 * Markdown, lockfiles and environment files. An extension's editor for one
 * of them is always offered under Open with and never takes the file by
 * default, whatever its `priority`, so installing an extension cannot change
 * how a person's code opens. A longer suffix (`.sketch.json`) is not one of
 * them, nor is an exact file name an editor lists.
 */
export const STUDIO_TEXT_EDITOR_SUFFIXES = [
  '.json',
  '.jsonc',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.md',
  '.markdown',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
  '.env',
  '.lock',
] as const

/**
 * Whether `editor` opens a file named `fileName` by default: it matches, its
 * priority is `default`, and what it matched is not one of the suffixes
 * Studio's text editor is for.
 */
export function customEditorOpensByDefault(
  editor: Pick<ExtensionCustomEditorContribution, 'extensions' | 'filenames' | 'priority'>,
  fileName: string,
): boolean {
  if ((editor.priority ?? 'default') !== 'default') return false
  const rank = customEditorMatchRank(editor, fileName)
  if (rank === 0) return false
  if (rank === 10_000) return true
  const name = fileName.toLowerCase()
  const matched = (editor.extensions ?? [])
    .map((suffix) => suffix.toLowerCase())
    .filter((suffix) => name.length > suffix.length && name.endsWith(suffix))
    .sort((a, b) => b.length - a.length)[0]
  return matched !== undefined && !(STUDIO_TEXT_EDITOR_SUFFIXES as readonly string[]).includes(matched)
}

/** The last segment of a path, `/` or `\` between its parts. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? ''
}
