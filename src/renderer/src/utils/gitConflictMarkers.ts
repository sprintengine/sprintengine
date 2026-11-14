export type GitConflictBlock = {
  index: number
  startOffset: number
  endOffset: number
  oursLabel: string
  theirsLabel: string
  ours: string
  theirs: string
}

type MarkerMatch = {
  kind: 'start' | 'separator' | 'end'
  label: string
  start: number
  end: number
}

const markerPattern = /^(<<<<<<<[ \t]*(.*)|=======[ \t]*|>>>>>>>[ \t]*(.*))$/gm

function findMarkers(content: string): MarkerMatch[] {
  const markers: MarkerMatch[] = []
  markerPattern.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = markerPattern.exec(content)) !== null) {
    const text = match[1] ?? ''
    const kind = text.startsWith('<<<<<<<') ? 'start' : text.startsWith('>>>>>>>') ? 'end' : 'separator'
    markers.push({
      kind,
      label: (match[2] ?? match[3] ?? '').trim(),
      start: match.index,
      end: markerPattern.lastIndex,
    })
  }

  return markers
}

export function parseGitConflictBlocks(content: string): GitConflictBlock[] {
  const markers = findMarkers(content)
  const blocks: GitConflictBlock[] = []

  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index]
    const separator = markers[index + 1]
    const end = markers[index + 2]
    if (start?.kind !== 'start' || separator?.kind !== 'separator' || end?.kind !== 'end') continue

    blocks.push({
      index: blocks.length,
      startOffset: start.start,
      endOffset: end.end,
      oursLabel: start.label || 'Pulled version',
      theirsLabel: end.label || 'Your stashed changes',
      ours: content
        .slice(start.end, separator.start)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, ''),
      theirs: content
        .slice(separator.end, end.start)
        .replace(/^\r?\n/, '')
        .replace(/\r?\n$/, ''),
    })
    index += 2
  }

  return blocks
}

export function hasGitConflictMarkers(content: string): boolean {
  return parseGitConflictBlocks(content).length > 0
}

/**
 * The file with one conflict block replaced. A block runs from the start of its
 * `<<<<<<<` line to the end of its `>>>>>>>` line, short of that line's own
 * break, so the break already there ends the replacement's last line: adding
 * another left a blank line under every resolved block. An empty replacement
 * takes the break with it, so no blank line marks where the block was.
 */
export function replaceGitConflictBlock(content: string, target: GitConflictBlock, replacement: string): string {
  const lineEnding = lineEndingOf(content)
  const before = content.slice(0, target.startOffset)
  let after = content.slice(target.endOffset)
  const ownBreak = /^\r?\n/.exec(after)?.[0] ?? ''
  after = after.slice(ownBreak.length)
  if (replacement === '') return `${before}${after}`
  // A block at the very end of a file with no final newline has no break of its
  // own, and the file keeps ending without one.
  const lineBreak = ownBreak || (after ? lineEnding : '')
  return `${before}${replacement}${lineBreak}${after}`
}

/** Both sides, ours first, joined with the file's own line ending. */
export function combineConflictSides(block: GitConflictBlock, lineEnding: '\n' | '\r\n' = '\n'): string {
  if (!block.ours) return block.theirs
  if (!block.theirs) return block.ours
  return `${block.ours}${lineEnding}${block.theirs}`
}

export function lineEndingOf(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n'
}
