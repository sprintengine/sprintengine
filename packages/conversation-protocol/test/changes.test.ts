import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CONVERSATION_MAX_CHANGES_STEPS, isConversationChangedPath } from '../src/checkoutChanges'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_CAPABILITIES, CONVERSATION_CHANGES_CAPABILITY } from '../src/handshake'
import { isKnownConversationServerFrameType, parseConversationServerFrame } from '../src/serverFrames'

// A chat's changes, read where it is followed (`conversation-changes`): a watch
// the client starts and stops, a step's files, and one file's two sides, by a
// step and a path and never a revision or a folder.

const key = { workspaceId: 'ws', agentId: 'chat' }
const hash = 'a'.repeat(40)
const step = { hash, shortHash: 'aaaaaaa', subject: 'Add the calendar screen', authoredAt: 1_000, isMerge: false }
const changes = {
  branch: 'feature/calendar',
  baseOid: 'b'.repeat(40),
  scope: 'worktree',
  steps: [step],
  hasUncommitted: true,
}

test('the capability is named, and each read is a request of its own', () => {
  assert.equal(CONVERSATION_CHANGES_CAPABILITY, 'conversation-changes')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_CHANGES_CAPABILITY))
  assert.deepEqual(parseConversationClientMessage({ type: 'watchChanges', requestId: 'r-1' }), {
    type: 'watchChanges',
    requestId: 'r-1',
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'watchChanges', requestId: 'r-2', stop: true }), {
    type: 'watchChanges',
    requestId: 'r-2',
    stop: true,
  })
  assert.deepEqual(
    parseConversationClientMessage({ type: 'getChangesDiff', requestId: 'r-3', selection: { kind: 'span' } }),
    { type: 'getChangesDiff', requestId: 'r-3', selection: { kind: 'span' } },
  )
  assert.deepEqual(
    parseConversationClientMessage({
      type: 'getChangedFile',
      requestId: 'r-4',
      selection: { kind: 'commit', hash },
      path: 'src/calendar.ts',
    }),
    { type: 'getChangedFile', requestId: 'r-4', selection: { kind: 'commit', hash }, path: 'src/calendar.ts' },
  )
})

test('a step names no revision but a commit, and a path names nothing outside the checkout', () => {
  const file = (selection: unknown, path: unknown) =>
    parseConversationClientMessage({ type: 'getChangedFile', requestId: 'r', selection, path })
  // A commit is a hash, never an option git would read.
  assert.equal(file({ kind: 'commit', hash: '--output=/tmp/x' }, 'a.ts'), null)
  assert.equal(file({ kind: 'commit', hash: 'HEAD' }, 'a.ts'), null)
  assert.equal(file({ kind: 'rev', rev: 'HEAD~3' }, 'a.ts'), null)
  for (const path of ['/Users/dev/.ssh/id_ed25519', '../outside.ts', 'src/../../outside.ts', 'C:\\x', '', 'a\0b'])
    assert.equal(file({ kind: 'span' }, path), null, path)
  assert.equal(isConversationChangedPath('src/deep/file.ts'), true)
  assert.equal(parseConversationClientMessage({ type: 'watchChanges', requestId: 'r', stop: false }), null)
  assert.equal(explainRejectedConversationMessage({ type: 'getChangesDiff', requestId: 'r' }).code, 'invalid_frame')
})

test('a changes frame says how the checkout stands, whole, and null where there is no repository', () => {
  assert.deepEqual(parseConversationServerFrame({ type: 'changes', key, changes, revision: 'rev-1' }), {
    type: 'changes',
    key,
    changes,
    revision: 'rev-1',
  })
  assert.deepEqual(parseConversationServerFrame({ type: 'changes', key, changes: null, revision: 'none' }), {
    type: 'changes',
    key,
    changes: null,
    revision: 'none',
  })
  // A scope this client does not know claims the least; a commit it cannot read is left out alone.
  const read = parseConversationServerFrame({
    type: 'changes',
    key,
    changes: { ...changes, scope: 'galaxy', steps: [{ ...step, hash: 'not-a-hash' }, step] },
    revision: 'rev-2',
  })
  assert.ok(read?.type === 'changes')
  assert.equal(read.changes?.scope, 'folder')
  assert.equal(read.changes?.steps.length, 1)
  const many = Array.from({ length: CONVERSATION_MAX_CHANGES_STEPS + 3 }, (_, index) => ({
    ...step,
    hash: index.toString(16).padStart(40, '0'),
  }))
  const capped = parseConversationServerFrame({
    type: 'changes',
    key,
    changes: { ...changes, steps: many },
    revision: 'r',
  })
  assert.ok(capped?.type === 'changes')
  assert.equal(capped.changes?.steps.length, CONVERSATION_MAX_CHANGES_STEPS)
  assert.equal(parseConversationServerFrame({ type: 'changes', key, changes }), null)
  assert.equal(parseConversationServerFrame({ type: 'changes', changes, revision: 'r' }), null)
  assert.ok(isKnownConversationServerFrameType({ type: 'changes' }))
})
