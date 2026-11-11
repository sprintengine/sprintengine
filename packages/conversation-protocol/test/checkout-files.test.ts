import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CONVERSATION_MAX_CHECKOUT_ENTRIES,
  CONVERSATION_MAX_CHECKOUT_MOVED_PATHS,
  isConversationCheckoutPath,
  parseConversationCheckoutChangeAnswer,
  parseConversationCheckoutFile,
  parseConversationCheckoutFolder,
} from '../src/checkoutFiles'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import { CONVERSATION_CAPABILITIES, CONVERSATION_CHECKOUT_FILES_CAPABILITY } from '../src/handshake'
import { isKnownConversationServerFrameType, parseConversationServerFrame } from '../src/serverFrames'

// A chat's files, read and changed where it is followed
// (`conversation-checkout-files`): a folder listed, a file read, a watch the
// client starts and stops, and the few changes the Files tab makes, each by a
// path relative to the chat's folder and never a folder of the client's own.

const key = { workspaceId: 'ws', agentId: 'chat' }

test('the capability is named and listed', () => {
  assert.equal(CONVERSATION_CHECKOUT_FILES_CAPABILITY, 'conversation-checkout-files')
  assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(CONVERSATION_CHECKOUT_FILES_CAPABILITY))
})

test('each read is a request of its own, by a path inside the folder', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'listCheckoutFolder', requestId: 'r-1', path: '' }), {
    type: 'listCheckoutFolder',
    requestId: 'r-1',
    path: '',
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'listCheckoutFolder', requestId: 'r-2', path: 'src/app' }), {
    type: 'listCheckoutFolder',
    requestId: 'r-2',
    path: 'src/app',
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'readCheckoutFile', requestId: 'r-3', path: 'src/a.ts' }), {
    type: 'readCheckoutFile',
    requestId: 'r-3',
    path: 'src/a.ts',
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'watchCheckoutFiles', requestId: 'r-4' }), {
    type: 'watchCheckoutFiles',
    requestId: 'r-4',
  })
  assert.deepEqual(parseConversationClientMessage({ type: 'watchCheckoutFiles', requestId: 'r-5', stop: true }), {
    type: 'watchCheckoutFiles',
    requestId: 'r-5',
    stop: true,
  })
  // The folder itself is listed, never read as a file.
  assert.equal(parseConversationClientMessage({ type: 'readCheckoutFile', requestId: 'r', path: '' }), null)
  assert.equal(parseConversationClientMessage({ type: 'watchCheckoutFiles', requestId: 'r', stop: false }), null)
  assert.equal(explainRejectedConversationMessage({ type: 'listCheckoutFolder', requestId: 'r' }).code, 'invalid_frame')
})

test('no path leads out of the folder', () => {
  for (const path of ['../a', 'src/../../a', 'src\\..\\a', '/etc/hosts', '\\share', 'C:/x', 'a\0b', './a', 'a/./b'])
    assert.equal(isConversationCheckoutPath(path), false, path)
  for (const path of ['', 'a', 'src/a.ts', '.github/workflows/ci.yml', 'a..b'])
    assert.ok(isConversationCheckoutPath(path))
  assert.equal(parseConversationClientMessage({ type: 'listCheckoutFolder', requestId: 'r', path: '../up' }), null)
  assert.equal(
    parseConversationClientMessage({
      type: 'changeCheckoutFile',
      requestId: 'r',
      change: { kind: 'rename', path: 'a.ts', to: '../a.ts' },
    }),
    null,
  )
})

test('a change is one of the five the Files tab makes, never of the folder itself', () => {
  const change = (value: unknown) =>
    parseConversationClientMessage({ type: 'changeCheckoutFile', requestId: 'c-1', change: value })
  assert.deepEqual(change({ kind: 'write', path: 'a.ts', content: 'x\n' }), {
    type: 'changeCheckoutFile',
    requestId: 'c-1',
    change: { kind: 'write', path: 'a.ts', content: 'x\n' },
  })
  for (const kind of ['createFile', 'createFolder', 'delete'] as const)
    assert.deepEqual(change({ kind, path: 'src/new' }), {
      type: 'changeCheckoutFile',
      requestId: 'c-1',
      change: { kind, path: 'src/new' },
    })
  assert.deepEqual(change({ kind: 'rename', path: 'a.ts', to: 'src/b.ts' }), {
    type: 'changeCheckoutFile',
    requestId: 'c-1',
    change: { kind: 'rename', path: 'a.ts', to: 'src/b.ts' },
  })
  assert.equal(change({ kind: 'delete', path: '' }), null)
  assert.equal(change({ kind: 'write', path: 'a.ts' }), null)
  assert.equal(change({ kind: 'chmod', path: 'a.ts' }), null)
  assert.equal(change({ kind: 'rename', path: 'a.ts' }), null)
})

test('a listing keeps the entries it can read, and names the folder for words', () => {
  assert.deepEqual(
    parseConversationCheckoutFolder({
      root: { name: 'app', path: '/Users/dev/app' },
      entries: [
        { name: 'src', kind: 'folder' },
        { name: 'dist', kind: 'folder', ignored: true },
        { name: 'README.md', kind: 'file' },
        { name: '../escape', kind: 'file' },
        { name: 'sock', kind: 'socket' },
      ],
      truncated: false,
    }),
    {
      root: { name: 'app', path: '/Users/dev/app' },
      entries: [
        { name: 'src', kind: 'folder' },
        { name: 'dist', kind: 'folder', ignored: true },
        { name: 'README.md', kind: 'file' },
      ],
      truncated: false,
    },
  )
  const many = Array.from({ length: CONVERSATION_MAX_CHECKOUT_ENTRIES + 2 }, (_, index) => ({
    name: `f${index}`,
    kind: 'file',
  }))
  assert.equal(
    parseConversationCheckoutFolder({ root: { name: 'a', path: '/a' }, entries: many, truncated: true })?.entries
      .length,
    CONVERSATION_MAX_CHECKOUT_ENTRIES,
  )
  assert.equal(parseConversationCheckoutFolder({ entries: [], truncated: false }), null)
})

test('a file reads as its text, too large, or not text', () => {
  assert.deepEqual(parseConversationCheckoutFile({ kind: 'text', content: 'x' }), { kind: 'text', content: 'x' })
  assert.deepEqual(parseConversationCheckoutFile({ kind: 'too-large', size: 9 }), { kind: 'too-large', size: 9 })
  assert.deepEqual(parseConversationCheckoutFile({ kind: 'binary' }), { kind: 'binary' })
  assert.equal(parseConversationCheckoutFile({ kind: 'text' }), null)
  assert.equal(parseConversationCheckoutFile({ kind: 'too-large', size: -1 }), null)
  assert.deepEqual(parseConversationCheckoutChangeAnswer({ path: 'src/b.ts' }), { path: 'src/b.ts' })
  assert.equal(parseConversationCheckoutChangeAnswer({ path: '../b.ts' }), null)
})

test('a checkoutFiles frame names what moved, or null for read everything again', () => {
  assert.deepEqual(parseConversationServerFrame({ type: 'checkoutFiles', key, paths: ['src/a.ts', ''] }), {
    type: 'checkoutFiles',
    key,
    paths: ['src/a.ts', ''],
  })
  assert.deepEqual(parseConversationServerFrame({ type: 'checkoutFiles', key, paths: null }), {
    type: 'checkoutFiles',
    key,
    paths: null,
  })
  // A path this client cannot read makes the frame a "read everything again".
  assert.deepEqual(parseConversationServerFrame({ type: 'checkoutFiles', key, paths: ['../x'] }), {
    type: 'checkoutFiles',
    key,
    paths: null,
  })
  const tooMany = Array.from({ length: CONVERSATION_MAX_CHECKOUT_MOVED_PATHS + 1 }, (_, index) => `f${index}`)
  assert.equal(parseConversationServerFrame({ type: 'checkoutFiles', key, paths: tooMany }), null)
  assert.equal(parseConversationServerFrame({ type: 'checkoutFiles', paths: null }), null)
  assert.ok(isKnownConversationServerFrameType({ type: 'checkoutFiles' }))
})
