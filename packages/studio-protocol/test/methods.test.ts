import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  STUDIO_COMMAND_METHODS,
  STUDIO_METHODS,
  STUDIO_TOPICS,
  isStudioMethod,
  parseStudioMethodParams,
  parseStudioTopicParams,
  type StudioMethod,
} from '../src/methods'
import { CONVERSATION_COMMAND_KINDS, CONVERSATION_MAX_MESSAGE_CHARS } from '../src/conversation'
import { STUDIO_CAPABILITIES } from '../src/handshake'
import { STUDIO_SCOPES } from '../src/scopes'

const key = { workspaceId: 'ws-1', agentId: 'agent-1' }

test('every method and topic names its scope and a capability this package defines', () => {
  // The type makes a missing entry a compile error; this makes a wrong one a
  // test failure, since a method with no scope would be open to every client.
  const methods = Object.keys(STUDIO_METHODS) as StudioMethod[]
  for (const method of methods) {
    const spec = STUDIO_METHODS[method]
    if (method === 'server.info' || method === 'server.ping' || method === 'update.status')
      assert.equal(spec.scope, null, method)
    // A method no scope reaches (a terminal's) is an owner's, never open to every client.
    else if (spec.scope === null) assert.ok(spec.owner, method)
    else assert.ok((STUDIO_SCOPES as readonly string[]).includes(spec.scope), method)
    if (spec.capability) assert.ok((STUDIO_CAPABILITIES as readonly string[]).includes(spec.capability), method)
    assert.equal(isStudioMethod(method), true)
  }
  for (const [topic, spec] of Object.entries(STUDIO_TOPICS))
    assert.ok(spec.scope === null ? spec.owner : STUDIO_SCOPES.includes(spec.scope), topic)
  assert.equal(isStudioMethod('constructor'), false)
  assert.equal(isStudioMethod('conversation.compact'), false)
})

test('every mutation is a method that carries a commandId, and every reader is not', () => {
  for (const [method, spec] of Object.entries(STUDIO_METHODS)) {
    const withoutId = parseStudioMethodParams(method as StudioMethod, { key, message: 'hi', workspaceId: 'ws-1' })
    if (spec.mutation) assert.equal(withoutId.ok, false, method)
  }
})

test('every conversation command kind has its method, so the socket drives a chat as fully as the tailnet', () => {
  const carried = new Set<string>(Object.values(STUDIO_COMMAND_METHODS))
  // A kind the socket carries by a method of its own rather than the lane's
  // command: Handoff, Edit from here and Revert came with the window's own
  // action, the lane's kind later, for a paired device; and a fork here is the
  // window's, which writes the new chat's record itself, where the lane's host
  // writes it for a paired device.
  const ownMethods: Record<string, StudioMethod> = {
    handoff: 'conversation.handoff',
    rewind: 'conversation.rewind',
    revert: 'conversation.revert',
    fork: 'conversation.fork',
  }
  for (const kind of CONVERSATION_COMMAND_KINDS)
    if (ownMethods[kind]) assert.ok(isStudioMethod(ownMethods[kind]), kind)
    else assert.ok(carried.has(kind), kind)
  for (const method of Object.keys(STUDIO_COMMAND_METHODS))
    assert.equal(STUDIO_METHODS[method as StudioMethod].mutation, true)
})

test('a command’s params are read by the conversation lane’s own validator, and refused in its words', () => {
  assert.deepEqual(parseStudioMethodParams('conversation.send', { key, commandId: 'c1', message: 'hi', junk: 1 }), {
    ok: true,
    params: { key, commandId: 'c1', message: 'hi' },
  })
  assert.deepEqual(
    parseStudioMethodParams('conversation.setPermissionPreset', {
      key,
      commandId: 'c2',
      preset: 'auto',
      permissionMode: 'acceptEdits',
    }),
    { ok: true, params: { key, commandId: 'c2', preset: 'auto', permissionMode: 'acceptEdits' } },
  )
  assert.deepEqual(
    parseStudioMethodParams('conversation.resolvePlan', { key, commandId: 'c3', requestId: 'p1', decision: 'approve' }),
    { ok: true, params: { key, commandId: 'c3', requestId: 'p1', decision: 'approve' } },
  )
  // A rule that outlives the conversation is read as the lane reads it
  // (`conversation-permanent-approvals`); the router holds it to the ceiling.
  assert.deepEqual(
    parseStudioMethodParams('conversation.resolveApproval', {
      key,
      commandId: 'c4',
      requestId: 'r1',
      decision: 'always',
    }),
    { ok: true, params: { key, commandId: 'c4', requestId: 'r1', decision: 'always' } },
  )
  const long = parseStudioMethodParams('conversation.send', {
    key,
    commandId: 'c5',
    message: 'x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1),
  })
  assert.deepEqual(long.ok ? null : long.code, 'too_large')
  const unknownPreset = parseStudioMethodParams('conversation.setPermissionPreset', {
    key,
    commandId: 'c6',
    preset: 'yolo',
  })
  assert.deepEqual(unknownPreset.ok ? null : unknownPreset.code, 'invalid_params')
  // A send names the uploads it carries; a malformed list is refused, never dropped.
  const pictures = parseStudioMethodParams('conversation.send', {
    key,
    commandId: 'c7',
    message: 'see',
    uploadIds: ['u1'],
  })
  assert.deepEqual(pictures.ok ? pictures.params : null, { key, commandId: 'c7', message: 'see', uploadIds: ['u1'] })
  const notAList = parseStudioMethodParams('conversation.send', {
    key,
    commandId: 'c7',
    message: 'see',
    uploadIds: 'u1',
  })
  assert.deepEqual(notAList.ok ? null : notAList.code, 'invalid_params')
  const noKey = parseStudioMethodParams('conversation.interrupt', { commandId: 'c8' })
  assert.deepEqual(noKey.ok ? null : noKey.code, 'invalid_params')
})

test('a create is the conversation create request plus the client’s commandId', () => {
  assert.deepEqual(
    parseStudioMethodParams('conversation.create', {
      commandId: 'create-1',
      workspaceId: ' ws-1 ',
      prompt: 'Hello',
      permissionPreset: 'auto',
      allowedTools: ['Write'],
      ownerModuleId: 'not-yours',
    }),
    {
      ok: true,
      params: {
        workspaceId: 'ws-1',
        prompt: 'Hello',
        permissionPreset: 'auto',
        allowedTools: ['Write'],
        commandId: 'create-1',
      },
    },
  )
  const bad = parseStudioMethodParams('conversation.create', {
    commandId: 'c',
    workspaceId: 'ws',
    allowedTools: 'Write',
  })
  assert.match(bad.ok ? '' : bad.message, /allowedTools/)
})

test('reads and the session stream take a key and their own bounds', () => {
  assert.deepEqual(parseStudioMethodParams('conversation.loadEarlier', { key, beforeCursor: 40, turnLimit: 5 }), {
    ok: true,
    params: { key, beforeCursor: 40, turnLimit: 5 },
  })
  assert.equal(parseStudioMethodParams('conversation.loadEarlier', { key, beforeCursor: -1 }).ok, false)
  assert.equal(parseStudioMethodParams('conversation.turnDiff', { key, turnSeq: 3, path: 'src/a.ts' }).ok, true)
  assert.deepEqual(parseStudioTopicParams('conversation.session', { key, turnLimit: 20 }), {
    ok: true,
    params: { key, turnLimit: 20 },
  })
  assert.equal(parseStudioTopicParams('conversation.session', { key, turnLimit: 101 }).ok, false)
  assert.equal(parseStudioMethodParams('conversation.list', 'nope').ok, false)
})

test('a create takes New chat’s options, held to its rules, and "No project" in place of a workspace', () => {
  const create = (params: Record<string, unknown>) =>
    parseStudioMethodParams('conversation.create', { commandId: 'c-1', ...params })
  assert.deepEqual(
    create({ workspaceId: 'ws-1', newChat: true, worktree: true, worktreeName: ' fix ', effort: 'high' }),
    {
      ok: true,
      params: {
        workspaceId: 'ws-1',
        newChat: true,
        worktree: true,
        worktreeName: 'fix',
        effort: 'high',
        commandId: 'c-1',
      },
    },
  )
  assert.deepEqual(create({ noProject: true, prompt: 'hi' }), {
    ok: true,
    params: { prompt: 'hi', noProject: true, commandId: 'c-1' },
  })
  for (const refused of [
    { noProject: true, workspaceId: 'ws-1' },
    { noProject: true, newChat: true, worktree: true },
    { noProject: false, workspaceId: 'ws-1' },
    { workspaceId: 'ws-1', worktree: true },
    { workspaceId: 'ws-1', newChat: true, worktreeName: 'fix' },
    { workspaceId: 'ws-1', inWorktree: '/Users/dev/app-wt' },
    { workspaceId: 'ws-1', newChat: true, worktree: true, inWorktree: '/Users/dev/app-wt' },
    { workspaceId: 'ws-1', effort: 'not an effort!' },
    {},
  ])
    assert.equal(create(refused).ok, false, JSON.stringify(refused))
})
