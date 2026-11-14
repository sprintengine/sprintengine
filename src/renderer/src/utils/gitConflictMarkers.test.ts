import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  combineConflictSides,
  conflictSideLabels,
  lineEndingOf,
  parseGitConflictBlocks,
  replaceGitConflictBlock,
} from './gitConflictMarkers'

const FILE = ['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature-x', 'bottom', ''].join('\n')

function resolve(content: string, pick: (block: ReturnType<typeof parseGitConflictBlocks>[number]) => string): string {
  const [block] = parseGitConflictBlocks(content)
  assert.ok(block)
  return replaceGitConflictBlock(content, block, pick(block))
}

test('each choice replaces the block with its lines and no blank line after them', () => {
  assert.equal(
    resolve(FILE, (block) => block.ours),
    'top\nours\nbottom\n',
  )
  assert.equal(
    resolve(FILE, (block) => block.theirs),
    'top\ntheirs\nbottom\n',
  )
  assert.equal(resolve(FILE, combineConflictSides), 'top\nours\ntheirs\nbottom\n')
})

test('an empty side leaves no blank line where the block was', () => {
  const content = ['top', '<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> feature-x', 'bottom', ''].join('\n')
  assert.equal(
    resolve(content, (block) => block.ours),
    'top\nbottom\n',
  )
})

test('CRLF files and a block at the end of a file keep their line endings', () => {
  const crlf = FILE.replaceAll('\n', '\r\n')
  assert.equal(
    resolve(crlf, (block) => combineConflictSides(block, lineEndingOf(crlf))),
    'top\r\nours\r\ntheirs\r\nbottom\r\n',
  )
  const atEnd = ['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature-x'].join('\n')
  assert.equal(
    resolve(atEnd, (block) => block.ours),
    'top\nours',
  )
})

test('the sides are named for the operation that stopped, not always for a stash', () => {
  assert.equal(conflictSideLabels('merge').ours, 'Current branch')
  assert.equal(conflictSideLabels('merge').theirs, 'Incoming branch')
  // A rebase's HEAD is the branch being rebased onto; "theirs" is your own commit.
  assert.equal(conflictSideLabels('rebase').theirs, 'Your commit')
  assert.equal(conflictSideLabels(null).theirs, 'Your stashed changes', 'a stash reapplied, with no operation')
})
