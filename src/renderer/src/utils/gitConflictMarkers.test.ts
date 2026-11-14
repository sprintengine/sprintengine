import assert from 'node:assert/strict'
import { test } from 'vitest'

import { combineConflictSides, lineEndingOf, parseGitConflictBlocks, replaceGitConflictBlock } from './gitConflictMarkers'

const FILE = ['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature-x', 'bottom', ''].join('\n')

function resolve(content: string, pick: (block: ReturnType<typeof parseGitConflictBlocks>[number]) => string): string {
  const [block] = parseGitConflictBlocks(content)
  assert.ok(block)
  return replaceGitConflictBlock(content, block, pick(block))
}

test('each choice replaces the block with its lines and no blank line after them', () => {
  assert.equal(resolve(FILE, (block) => block.ours), 'top\nours\nbottom\n')
  assert.equal(resolve(FILE, (block) => block.theirs), 'top\ntheirs\nbottom\n')
  assert.equal(resolve(FILE, combineConflictSides), 'top\nours\ntheirs\nbottom\n')
})

test('an empty side leaves no blank line where the block was', () => {
  const content = ['top', '<<<<<<< HEAD', '=======', 'theirs', '>>>>>>> feature-x', 'bottom', ''].join('\n')
  assert.equal(resolve(content, (block) => block.ours), 'top\nbottom\n')
})

test('CRLF files and a block at the end of a file keep their line endings', () => {
  const crlf = FILE.replaceAll('\n', '\r\n')
  assert.equal(
    resolve(crlf, (block) => combineConflictSides(block, lineEndingOf(crlf))),
    'top\r\nours\r\ntheirs\r\nbottom\r\n',
  )
  const atEnd = ['top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature-x'].join('\n')
  assert.equal(resolve(atEnd, (block) => block.ours), 'top\nours')
})
