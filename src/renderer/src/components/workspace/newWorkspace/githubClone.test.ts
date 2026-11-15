import assert from 'node:assert/strict'
import { test } from 'vitest'

import { cloneParentFor, describeCloneProgress, resolveCloneSource } from './githubClone'

test('a blank draft is nothing chosen yet, not an error', () => {
  const blank = resolveCloneSource('   ')
  assert.equal(blank.source, null)
  assert.equal(blank.error, null)
})

test('a pasted URL resolves to what the preview shows', () => {
  const pasted = resolveCloneSource('https://gitlab.acme.dev/platform/api/-/tree/develop')
  assert.equal(pasted.source?.repoName, 'api')
  assert.equal(pasted.source?.providerName, 'GitLab')
  assert.equal(pasted.source?.location, 'gitlab.acme.dev/platform/api')
  assert.equal(pasted.source?.branch, 'develop')
})

test('a draft that does not parse carries its error inline', () => {
  const invalid = resolveCloneSource('ftp://nope')
  assert.equal(invalid.source, null)
  assert.ok(invalid.error)
})

test('progress reads as one line of words', () => {
  assert.equal(describeCloneProgress(null), 'Starting…')
  assert.equal(describeCloneProgress({ stage: 'connecting', percent: null, detail: null }), 'Connecting')
  assert.equal(
    describeCloneProgress({ stage: 'receiving', percent: 45, detail: '12.30 MiB | 5.00 MiB/s' }),
    'Receiving objects · 45% · 12.30 MiB | 5.00 MiB/s',
  )
})

test('picking a folder already named for the clone clones into it, not into a folder inside it', () => {
  assert.equal(cloneParentFor('/Users/dev/code', 'widget'), '/Users/dev/code')
  assert.equal(cloneParentFor('/Users/dev/code/widget', 'widget'), '/Users/dev/code')
})
