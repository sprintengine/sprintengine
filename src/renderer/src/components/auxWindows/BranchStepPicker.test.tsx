import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, test } from 'vitest'

import { BranchStepPicker, branchStepLabel } from './BranchStepPicker'
import { stripEntriesFrom } from './branchSteps'
import type { BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'

// The branch step picker: which part of the branch the diff shows, as one
// select at the top of the files column.

// The kit's Tooltip and Popover use layout effects, a no-op under the static
// renderer; React says so once per render.
const consoleError = console.error
beforeEach(() => {
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
    consoleError(...args)
  }
})
afterEach(() => {
  console.error = consoleError
})

function snapshot(patch: Partial<BranchStepsSnapshot> = {}): BranchStepsSnapshot {
  return {
    branch: 'feat',
    baseOid: 'base000',
    scope: 'worktree',
    steps: [
      { hash: 'aaaaaa1', shortHash: 'aaaaaa', subject: 'first', authoredAt: 1, isMerge: false },
      { hash: 'bbbbbb2', shortHash: 'bbbbbb', subject: 'Merge main', authoredAt: 2, isMerge: true },
    ],
    hasUncommitted: true,
    ...patch,
  }
}

function picker(
  snap: BranchStepsSnapshot | null,
  selection: BranchStepSelection = { kind: 'span' },
  note: string | null = null,
): string {
  return renderToStaticMarkup(
    <BranchStepPicker entries={stripEntriesFrom(snap)} selection={selection} onSelect={() => {}} note={note} />,
  )
}

test('the picker is one named select showing the step on screen', () => {
  const markup = picker(snapshot(), { kind: 'commit', hash: 'bbbbbb2' })
  assert.equal((markup.match(/role="combobox"/g) ?? []).length, 1)
  assert.match(markup, /aria-label="Branch steps"/)
  assert.match(markup, /bbbbbb Merge main/, 'the chosen commit, hash before subject')
  assert.doesNotMatch(markup, /role="tablist"/, 'no row of chips')
})

test('a commit reads as its short hash and subject; the span and the tail as their names', () => {
  const entries = stripEntriesFrom(snapshot())
  assert.deepEqual(entries.map(branchStepLabel), [
    entries[0].label,
    entries[1].label,
    'aaaaaa first',
    'bbbbbb Merge main',
  ])
  assert.equal(entries[0].hash, undefined)
})

test('with one step there is no choice, so no select', () => {
  assert.equal(picker(snapshot({ steps: [], hasUncommitted: true })), '')
})

test('a checkout that cannot claim exactness still says so, in the mark beside the select', () => {
  const markup = picker(
    snapshot({ steps: [], hasUncommitted: false, scope: 'folder' }),
    { kind: 'span' },
    'Working on main. There is no branch to measure.',
  )
  assert.match(markup, /role="img"[^>]*aria-label="Working on main\. There is no branch to measure\."/)
  assert.doesNotMatch(markup, /role="combobox"/)
})

test('no mark when the checkout is exact', () => {
  assert.doesNotMatch(picker(snapshot(), { kind: 'span' }, null), /role="img"/)
})
