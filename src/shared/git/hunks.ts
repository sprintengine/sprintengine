export type {
  DiffHunk,
  GitHunkScope,
  GitHunkView,
  GitHunkUnsupported,
  GitFileHunks,
  GitFileHunksResult,
  GitHunkRef,
  HunkInclusionSummary,
} from '../../../packages/studio-protocol/src/public'
import type {
  DiffHunk,
  GitHunkScope,
  GitHunkView,
  HunkInclusionSummary,
} from '../../../packages/studio-protocol/src/public'
// Unified diffs, read as hunks — git-commit-window T7, "include a hunk".
//
// Everything in this file is pure text. The MAIN process produces the diffs
// (`git diff -U0` and `git diff --cached -U0`) and applies the patches it
// builds from them; this file only reads what git wrote. It lives in `shared`
// because the renderer needs the same vocabulary — where a hunk sits, what
// identifies it, and how many of a file's differences are in the index —
// without ever holding a patch of its own. A patch the renderer synthesised is
// never applied: the renderer names a hunk, main finds it again and writes the
// patch itself.
//
// Two rules the rest of the feature rests on:
//
//   1. **Split on `\n`, never on `\r?\n`.** In a CRLF file's diff the `\r` is
//      part of the line's CONTENT, and a patch that lost it would not match the
//      index it is applied to. Every line here keeps whatever bytes git gave
//      it.
//   2. **A hunk is identified by its body, not by its position.** Staging one
//      hunk moves every later hunk's line numbers, so an offset read a second
//      ago is already wrong. `hunkFingerprint` / `locateHunk` are how a hunk
//      survives that.

/** One file's entry in a diff: everything before the first `@@`, then the hunks. */
export type ParsedFileDiff = {
  /**
   * `diff --git …` and every header line after it — `new file mode`,
   * `deleted file mode`, `index …`, `--- a/x`, `+++ b/x`. Kept verbatim and
   * replayed verbatim into a one-hunk patch, which is what makes a new file's
   * `/dev/null` side and a deletion's mode line correct without this file
   * having to know the rules for either.
   */
  header: string[]
  /** From the `--- ` line; null for `/dev/null` (the file is being created). */
  oldPath: string | null
  /** From the `+++ ` line; null for `/dev/null` (the file is being deleted). */
  newPath: string | null
  /** git said "Binary files … differ" or emitted a binary patch. No hunks. */
  binary: boolean
  hunks: DiffHunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function pathFromMarker(line: string, marker: string): string | null {
  const value = line.slice(marker.length).trim()
  if (value === '/dev/null') return null
  // `--- a/src/x.ts` → `src/x.ts`. A path git had to quote is left as git wrote
  // it: it is only ever compared to another of git's own, never to a real path.
  return value.replace(/^[ab]\//, '')
}

/**
 * Read `git diff` output into files and hunks.
 *
 * Deliberately forgiving about what it does not understand: a line it cannot
 * place is a header line, and an unrecognised file entry is a file with no
 * hunks — which reads downstream as "nothing here can be included one change at
 * a time", the honest answer, rather than a throw in the middle of a diff.
 */
export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = []
  if (!text) return files

  // See rule 1 at the top: `\n` only, so a CRLF line keeps its `\r`.
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let file: ParsedFileDiff | null = null
  let hunk: DiffHunk | null = null

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { header: [line], oldPath: null, newPath: null, binary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue

    const match = HUNK_HEADER.exec(line)
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      file.hunks.push(hunk)
      continue
    }

    if (hunk) {
      // `\` is the no-newline marker and belongs to the hunk it follows: a
      // patch that dropped it would silently add a trailing newline.
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) {
        hunk.lines.push(line)
        continue
      }
      hunk = null
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }
    // Header lines only ever precede the first hunk; anything after one is
    // trailing noise and is not replayed into a patch.
    if (file.hunks.length > 0) continue
    if (line.startsWith('--- ')) file.oldPath = pathFromMarker(line, '--- ')
    if (line.startsWith('+++ ')) file.newPath = pathFromMarker(line, '+++ ')
    file.header.push(line)
  }

  return files
}

/** `@@ -3,2 +3,0 @@` — git's own spelling, `,1` omitted exactly as git omits it. */
export function formatHunkHeader(hunk: DiffHunk): string {
  const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`)
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`
}

/**
 * What a hunk IS, with no coordinates in it.
 *
 * Staging the hunk above this one rewrites this one's `oldStart` and
 * `newStart`; nothing rewrites its body. So the body is the identity, and a
 * renderer that asks to stage "the hunk that removes these two lines and adds
 * this one" is asking for something that survives the diff being recomputed —
 * which it is, on every toggle.
 */
export function hunkFingerprint(hunk: DiffHunk): string {
  return hunk.lines.join('\n')
}

export type LocateHunkResult = { ok: true; hunk: DiffHunk; index: number } | { ok: false; reason: 'gone' | 'ambiguous' }

/**
 * Find a hunk again in a freshly read diff, by content.
 *
 * `index` is a hint and never a decision: it is accepted only when the hunk
 * standing there has the fingerprint asked for. Otherwise the whole diff is
 * searched, and an answer is given only when exactly one hunk matches — two
 * identical hunks in one file with the position hint gone is genuinely
 * ambiguous, and staging a guess would be staging the wrong lines.
 */
export function locateHunk(hunks: DiffHunk[], index: number, fingerprint: string): LocateHunkResult {
  const at = hunks[index]
  if (at && hunkFingerprint(at) === fingerprint) return { ok: true, hunk: at, index }
  const matches = hunks
    .map((hunk, position) => ({ hunk, position }))
    .filter((entry) => hunkFingerprint(entry.hunk) === fingerprint)
  if (matches.length === 1) return { ok: true, hunk: matches[0].hunk, index: matches[0].position }
  return { ok: false, reason: matches.length === 0 ? 'gone' : 'ambiguous' }
}

/* ------------------------------------------------------------------ *
 * The counter
 * ------------------------------------------------------------------ */

/**
 * How many of a file's differences are in the index, and how many there are.
 *
 * `staged` is HEAD→index (`git diff --cached -U0`) and `unstaged` is
 * index→worktree (`git diff -U0`). Those two sets PARTITION the file's
 * differences: every changed line of the file is in exactly one of them,
 * because the index is the boundary they are each measured from. So the total
 * is their sum and the included count is the staged half — matched by content
 * rather than by position, because the two diffs are read independently and
 * nothing says the index's first hunk is the file's first hunk.
 *
 * The alternative — count HEAD→worktree hunks and mark the ones the index also
 * has — was tried and rejected: when a person includes half of a `-U0` hunk
 * (two adjacent changed lines, one of them staged), the index's hunk is a
 * strict subset of the HEAD→worktree hunk and matches nothing, so the counter
 * would say "1 difference, 0 included" beside a checkbox showing the mixed
 * dash. The partition cannot produce that disagreement: a partially staged
 * file always has at least one hunk on each side, so `0 < included < total`
 * exactly when the file box is indeterminate.
 */
export function summariseInclusion(staged: DiffHunk[], unstaged: DiffHunk[]): HunkInclusionSummary {
  return { total: staged.length + unstaged.length, included: staged.length }
}

/* ------------------------------------------------------------------ *
 * The IPC vocabulary
 * ------------------------------------------------------------------ */

/**
 * What names one box across a re-read.
 *
 * Not the index: staging one hunk renumbers every later hunk of both diffs, and
 * the union interleaves them, so index 1 a second ago is not index 1 now. The
 * body is the identity (`hunkFingerprint`) and the scope is what tells the two
 * halves of the union apart when a file has the same change on both sides.
 */
export function hunkKey(hunk: Pick<GitHunkView, 'scope' | 'fingerprint'>): string {
  return `${hunk.scope}\n${hunk.fingerprint}`
}

/** Which way a click on this hunk's box goes. There is no third case: a hunk is
 *  in the index or it is not. */
export function hunkToggleScope(hunk: Pick<GitHunkView, 'included'>): GitHunkScope {
  return hunk.included ? 'staged' : 'unstaged'
}

/**
 * Where a hunk's include box is drawn: a line number in the MODIFIED editor,
 * which is the one editor visible in both side-by-side and unified view.
 *
 * A pure deletion has no line on the new side — git writes `@@ -3 +2,0 @@`,
 * where 2 is the last surviving line BEFORE the gap — so the box sits on that
 * line, immediately above the removed text in both views. A deletion at the
 * very top of the file gives `+0,0` and clamps to line 1.
 */
export function hunkGutterLine(hunk: Pick<GitHunkView, 'newStart' | 'newLines'>): number {
  return Math.max(1, hunk.newStart)
}
