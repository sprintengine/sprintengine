import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_CHAT_LIFECYCLE_METHODS } from '../src/chat-lifecycle'
import { STUDIO_CAPABILITIES } from '../src/handshake'
import { STUDIO_METHOD_ACCESS, parseStudioMethodParams, studioGrantAllows } from '../src/methods'

// A chat's record beyond its rest, as its params are read: what is kept,
// what is refused before the Studio is asked, and who may ask.

const ok = <T>(parsed: { ok: boolean; params?: T }) => (parsed.ok ? parsed.params : undefined)
const refused = (parsed: { ok: boolean }) => parsed.ok === false
const chat = { workspaceId: 'ws-1' }

test('every change names its chat by its workspace and carries a command id; the plan and the search are reads', () => {
  assert.ok(STUDIO_CAPABILITIES.includes('chat-lifecycle'))
  for (const [method, spec] of Object.entries(STUDIO_CHAT_LIFECYCLE_METHODS)) {
    assert.equal(spec.capability, 'chat-lifecycle', method)
    if (!spec.mutation) continue
    assert.equal(spec.scope, 'conversation:operate', method)
    assert.ok(refused(parseStudioMethodParams(method as never, chat)), `${method} refuses no commandId`)
    assert.ok(refused(parseStudioMethodParams(method as never, { commandId: 'c' })), `${method} refuses no workspace`)
  }
  assert.equal(STUDIO_CHAT_LIFECYCLE_METHODS['conversation.deletePlan'].scope, 'conversation:read')
  assert.equal(STUDIO_CHAT_LIFECYCLE_METHODS['conversation.searchChats'].scope, 'conversation:read')
  assert.deepEqual(ok(parseStudioMethodParams('conversation.markUnread', { ...chat, commandId: 'c', extra: 1 })), {
    ...chat,
    commandId: 'c',
  })
})

test('a snooze wakes at a whole instant or now; a highlight says what it changes', () => {
  assert.deepEqual(ok(parseStudioMethodParams('conversation.snooze', { ...chat, commandId: 'c', until: null })), {
    ...chat,
    commandId: 'c',
    until: null,
  })
  assert.ok(refused(parseStudioMethodParams('conversation.snooze', { ...chat, commandId: 'c' })))
  assert.ok(refused(parseStudioMethodParams('conversation.snooze', { ...chat, commandId: 'c', until: 1.5 })))
  assert.deepEqual(ok(parseStudioMethodParams('conversation.highlight', { ...chat, commandId: 'c', color: null })), {
    ...chat,
    commandId: 'c',
    color: null,
  })
  assert.ok(refused(parseStudioMethodParams('conversation.highlight', { ...chat, commandId: 'c' })))
  assert.ok(refused(parseStudioMethodParams('conversation.highlight', { ...chat, commandId: 'c', color: 'teal' })))
  assert.ok(refused(parseStudioMethodParams('conversation.setAutoSettle', { ...chat, commandId: 'c', enabled: 'yes' })))
})

test('a name is trimmed and bounded; a search is two to two hundred characters', () => {
  assert.equal(
    ok(parseStudioMethodParams('conversation.rename', { ...chat, commandId: 'c', name: '  Fix it ' }))?.name,
    'Fix it',
  )
  assert.ok(refused(parseStudioMethodParams('conversation.rename', { ...chat, commandId: 'c', name: '   ' })))
  assert.ok(refused(parseStudioMethodParams('conversation.rename', { ...chat, commandId: 'c', name: 'x'.repeat(501) })))
  assert.deepEqual(ok(parseStudioMethodParams('conversation.searchChats', { query: ' login ' })), { query: 'login' })
  assert.ok(refused(parseStudioMethodParams('conversation.searchChats', { query: 'a' })))
  assert.ok(refused(parseStudioMethodParams('conversation.searchChats', { query: 'a'.repeat(201) })))
})

test('reading a chat may search and plan; only driving it may change it', () => {
  const reader = { owner: false, scopes: ['conversation:read'] } as const
  const driver = { owner: false, scopes: ['conversation:operate'] } as const
  assert.equal(studioGrantAllows(reader, 'conversation.searchChats'), true)
  assert.equal(studioGrantAllows(reader, 'conversation.deletePlan'), true)
  assert.equal(studioGrantAllows(reader, 'conversation.rename'), false)
  assert.equal(studioGrantAllows(driver, 'conversation.delete'), true)
  assert.equal(STUDIO_METHOD_ACCESS['conversation.delete'] !== undefined, true)
})
