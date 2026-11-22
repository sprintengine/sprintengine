import type { TranscriptToolEntry } from '../conversationProjection'

// The decisions behind the editor an agent's `file.view` draws in a chat,
// kept apart from the drawing so each can be tested on its own.

export type FileViewHighlight = { from: number; to: number; note?: string }

/** One file the view holds: its path on the chat's machine, its name, and the lines to look at. */
export type FileViewFile = { path: string; name: string; highlights: FileViewHighlight[] }

/** How long a pause in typing is before the file is saved. */
export const FILE_VIEW_SAVE_PAUSE_MS = 800

/** The editor's height bounds, in lines: it grows with a short file, and scrolls past the most. */
export const FILE_VIEW_MIN_LINES = 3
export const FILE_VIEW_MAX_LINES = 18

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function highlightsOf(value: unknown): FileViewHighlight[] {
  if (!Array.isArray(value)) return []
  const ranges: FileViewHighlight[] = []
  for (const item of value) {
    if (!record(item) || typeof item.from !== 'number' || !Number.isFinite(item.from)) continue
    const from = Math.max(1, Math.trunc(item.from))
    const to = typeof item.to === 'number' && Number.isFinite(item.to) ? Math.max(from, Math.trunc(item.to)) : from
    const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined
    ranges.push({ from, to, ...(note ? { note } : {}) })
  }
  return ranges.sort((a, b) => a.from - b.from)
}

const nameOf = (path: string) => path.split(/[\\/]/u).filter(Boolean).pop() ?? path

/**
 * The files a `file.view` call showed, as its answer names them: each by the
 * real path the chat's Studio resolved, which is the only path it saves by.
 * Empty when the answer cannot be read (a failed call, or one cut short on
 * the wire): the call then stays its tool row.
 */
export function fileViewFiles(tool: Pick<TranscriptToolEntry, 'output' | 'outputStatus'>): FileViewFile[] {
  if (tool.outputStatus === 'error' || !tool.output) return []
  let answer: unknown
  try {
    answer = JSON.parse(tool.output)
  } catch {
    return []
  }
  if (!record(answer) || !Array.isArray(answer.files)) return []
  const files: FileViewFile[] = []
  for (const item of answer.files) {
    if (!record(item) || typeof item.path !== 'string' || !item.path) continue
    if (files.some((file) => file.path === item.path)) continue
    files.push({
      path: item.path,
      name: typeof item.name === 'string' && item.name ? item.name : nameOf(item.path),
      highlights: highlightsOf(item.highlights),
    })
  }
  return files
}

/**
 * The tab labels: a file's name, or, where two files share it, as many of its
 * last path parts as tell it from the others (`a/CLAUDE.md`, `b/CLAUDE.md`).
 */
export function fileViewTabLabels(files: readonly FileViewFile[]): string[] {
  const parts = files.map((file) => file.path.split(/[\\/]/u).filter(Boolean))
  const tail = (index: number, depth: number) => parts[index]!.slice(-depth).join('/')
  return files.map((file, index) => {
    const twins = files.map((_, other) => other).filter((other) => other !== index && files[other]!.name === file.name)
    if (twins.length === 0) return file.name
    for (let depth = 2; depth <= parts[index]!.length; depth += 1) {
      const label = tail(index, depth)
      if (twins.every((other) => tail(other, depth) !== label)) return label
    }
    return file.path
  })
}

/** How many lines tall the editor is for a file of `lines`. */
export function fileViewHeightLines(lines: number): number {
  return Math.min(FILE_VIEW_MAX_LINES, Math.max(FILE_VIEW_MIN_LINES, lines))
}

/** What the view says of a file's save, beside its path. */
export type FileViewSaveState =
  | { kind: 'loading' }
  | { kind: 'saved' }
  | { kind: 'unsaved' }
  | { kind: 'saving' }
  | { kind: 'conflict'; gone: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'unreadable'; message: string }

/** One file's state in the view: its text as typed, the hash the next save is conditional on, how its save stands. */
export type FileViewEntry = {
  text: string
  /** The SHA-256 of the file as last read or saved; null before it is read. */
  hash: string | null
  /** The text as last read or saved, to tell an edit from none. */
  savedText: string
  save: FileViewSaveState
}

export const LOADING_ENTRY: FileViewEntry = { text: '', hash: null, savedText: '', save: { kind: 'loading' } }

/** Whether the person's edits are not on disk: what a save, now or after the pause, is for. */
export function fileViewDirty(entry: FileViewEntry): boolean {
  return entry.hash !== null && entry.text !== entry.savedText
}
