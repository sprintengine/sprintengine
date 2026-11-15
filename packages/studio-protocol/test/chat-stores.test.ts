import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_CHAT_STORES_METHODS, STUDIO_CHAT_STORES_TOPICS } from '../src/chat-stores'
import {
  STUDIO_METHOD_ACCESS,
  parseStudioMethodParams,
  parseStudioTopicParams,
  studioGrantAllows,
} from '../src/methods'

// What a Studio keeps beside its chats, as its params are read: what is kept,
// what is dropped, and what is refused before a store is asked; and who may
// ask.

const ok = <T>(parsed: { ok: boolean; params?: T }) => (parsed.ok ? parsed.params : undefined)
const refused = (parsed: { ok: boolean }) => parsed.ok === false

test('every change carries a command id; every read and stream takes nothing', () => {
  for (const [method, spec] of Object.entries(STUDIO_CHAT_STORES_METHODS)) {
    if (spec.mutation)
      assert.ok(refused(parseStudioMethodParams(method as never, {})), `${method} refuses no commandId`)
  }
  assert.deepEqual(ok(parseStudioMethodParams('usageLimitResumes.get', { extra: 1 })), {})
  for (const topic of Object.keys(STUDIO_CHAT_STORES_TOPICS))
    assert.deepEqual(ok(parseStudioTopicParams(topic as never, { extra: 1 })), {})
})

test('a resume is one chat’s action; the setting is a method of its own', () => {
  assert.deepEqual(
    ok(
      parseStudioMethodParams('usageLimitResumes.update', {
        commandId: 'c',
        workspaceId: 'w',
        agentId: 'a',
        action: 'retry',
      }),
    ),
    { commandId: 'c', workspaceId: 'w', agentId: 'a', action: 'retry' },
  )
  assert.ok(
    refused(
      parseStudioMethodParams('usageLimitResumes.update', {
        commandId: 'c',
        workspaceId: 'w',
        agentId: 'a',
        action: 'auto',
      }),
    ),
  )
  assert.deepEqual(ok(parseStudioMethodParams('usageLimitResumes.setAuto', { commandId: 'c', enabled: false })), {
    commandId: 'c',
    enabled: false,
  })
  assert.ok(refused(parseStudioMethodParams('usageLimitResumes.setAuto', { commandId: 'c', enabled: 'yes' })))
})

test('a usage report names a span and how to ask the paired machines; an import names sessions by source and id', () => {
  assert.deepEqual(
    ok(parseStudioMethodParams('usage.report', { from: 1, to: 2, peers: 'ask', machines: ['local'], x: 1 })),
    {
      from: 1,
      to: 2,
      peers: 'ask',
      machines: ['local'],
    },
  )
  assert.ok(refused(parseStudioMethodParams('usage.report', { from: 2, to: 1 })), 'backwards')
  assert.ok(refused(parseStudioMethodParams('usage.report', { from: 1, to: 2, peers: 'all' })))
  assert.deepEqual(
    ok(
      parseStudioMethodParams('conversationImport.import', {
        commandId: 'c',
        sessions: [{ source: 'codex', sessionId: 's1', title: 'dropped' }],
      }),
    ),
    { commandId: 'c', sessions: [{ source: 'codex', sessionId: 's1' }] },
  )
  assert.ok(
    refused(
      parseStudioMethodParams('conversationImport.import', {
        commandId: 'c',
        sessions: [{ source: 'x', sessionId: 's' }],
      }),
    ),
  )
})

test('reading a chat’s limit notice is conversation:read, changing it drives the chat, and the report and the import are an owner’s', () => {
  assert.deepEqual(STUDIO_METHOD_ACCESS['usageLimitResumes.get'], { permissions: ['conversation:read'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['usageLimits.get'], { permissions: ['providers:read'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['usageLimitResumes.setAuto'], { permissions: ['settings:write'] })
  const owners = Object.keys(STUDIO_CHAT_STORES_METHODS).filter((method) => {
    const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_METHOD_ACCESS]
    return 'permissions' in access && access.owner !== undefined
  })
  assert.deepEqual(owners.sort(), ['conversationImport.import', 'conversationImport.scan', 'usage.report'])
  const reader = { owner: false, scopes: ['conversation:read'] }
  assert.equal(studioGrantAllows(reader, 'usageLimitResumes.get'), true)
  assert.equal(studioGrantAllows(reader, 'usageLimitResumes.update'), false)
  // A chat's held and scheduled messages are its own, read and changed per chat.
  assert.equal('scheduledMessages.get' in STUDIO_METHOD_ACCESS, false)
  assert.equal(
    studioGrantAllows({ owner: false, scopes: ['conversation:operate'] }, 'usageLimitResumes.setAuto'),
    false,
  )
  assert.equal(studioGrantAllows({ owner: false, scopes: ['providers:read'] }, 'usage.report'), false)
  assert.equal(studioGrantAllows({ owner: true, scopes: ['providers:read'] }, 'usage.report'), true)
})
