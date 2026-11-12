import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import {
  STUDIO_FOLLOWED_METHODS,
  STUDIO_FOLLOWED_TOPICS,
  STUDIO_METHOD_ACCESS,
  studioGrantAllows,
  studioGrantAllowsTopic,
  type StudioParsedServerFrame,
} from '../../../packages/studio-protocol/src/public'
import type { StudioFollowedBackend } from './studio-rpc-types'
import {
  STUDIO_RPC_WITHHELD_CONVERSATION_CAPABILITIES,
  studioRpcConversationCapabilities,
} from './studio-rpc-server'
import {
  OWNER_TOKEN,
  connectLineClient,
  createFakeBackend,
  hello,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'

// What a follower of one chat reads and does beside its stream, by the chat's
// key (`followed.ts`): the tailnet lane's per-chat watches, side questions,
// context breakdown, composer reads, lifecycle and changes, served on the
// Studio socket over the same host. Each is tried under an owner's grant, a
// paired client's that may operate, a read-only one and a revoked one.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const KEY = { workspaceId: 'ws-1', agentId: 'agent-1' }

type Calls = Array<[string, ...unknown[]]>

/** The host's per-chat reads, as a fake: each records its call and answers in the host's shape. */
function fakeFollowed(calls: Calls): Required<StudioFollowedBackend> & { tell(kind: string, value: unknown): void } {
  const watchers = new Map<string, Set<(value: unknown) => void>>()
  const watch =
    (kind: string, now: unknown) =>
    (chat: { workspaceId: string; agentId: string }, listener: (value: never) => void) => {
      calls.push([kind, chat])
      const set = watchers.get(kind) ?? new Set()
      watchers.set(kind, set)
      const each = listener as (value: unknown) => void
      set.add(each)
      each(now)
      return () => {
        calls.push([`${kind}:stop`])
        set.delete(each)
      }
    }
  return {
    tell(kind, value) {
      for (const listener of watchers.get(kind) ?? []) listener(value)
    },
    watchQueued: watch('queued', []),
    watchScheduled: watch('scheduled', []),
    watchUsageLimits: watch('usageLimits', { notice: null, autoResume: false, limits: [] }),
    watchSubagents: watch('subagents', []),
    watchChanges: watch('changes', { changes: null, revision: 'r1' }),
    async changesDiff(chat, selection) {
      calls.push(['changesDiff', chat, selection])
      return { ok: true, files: [], additions: 0, deletions: 0 }
    },
    async changedFile(chat, selection, path) {
      calls.push(['changedFile', chat, selection, path])
      if (path === 'elsewhere.txt') return { ok: false, code: 'not_found', message: 'That file is not in this step.' }
      return { ok: true, original: { kind: 'absent' }, modified: { kind: 'content', content: 'hi' } }
    },
    async askSideQuestion(key, clientId, questionId, question, history) {
      calls.push(['askSideQuestion', key.agentId, clientId, questionId, question, history])
      return { ok: true, answer: `About ${question}` }
    },
    async cancelSideQuestion(clientId, questionId) {
      calls.push(['cancelSideQuestion', clientId, questionId])
      return { ok: true }
    },
    async contextBreakdown(key) {
      calls.push(['contextBreakdown', key.agentId])
      return { ok: false, reason: 'not-running', message: 'Nothing is running in this chat.' }
    },
    async searchFiles(key, clientId, query, limit) {
      calls.push(['searchFiles', key.agentId, clientId, query, limit])
      return { ok: true, answer: { entries: [{ path: 'src/app.ts', kind: 'file' }], truncated: false } }
    },
    async listCommands(key, refresh) {
      calls.push(['listCommands', key.agentId, refresh])
      return { ok: true, answer: { cli: 'claude-code', commands: [], fetchedAt: 1 } }
    },
    settle(chat, settled, byOwner) {
      calls.push(['settle', chat, settled, byOwner])
      if (chat.agentId === 'busy')
        return { ok: false, code: 'working', message: 'An agent in this chat is working. Settle it once it stops.' }
      return { ok: true, settledAt: settled ? 1_000 : null }
    },
    visit(chat, visitedAt, byOwner) {
      calls.push(['visit', chat, visitedAt, byOwner])
      return { ok: true, lastVisitedAt: visitedAt ?? 2_000 }
    },
  }
}

async function serve() {
  const calls: Calls = []
  const followed = fakeFollowed(calls)
  const backend = createFakeBackend(['agent-1', 'busy'])
  backend.followed = followed
  const started = await startTestServer({ backend })
  cleanups.push(() => started.dispose())
  return { ...started, calls, followed }
}

async function client(path: string, token: string): Promise<LineClient> {
  const c = await connectLineClient(path)
  cleanups.push(() => c.close())
  c.send(hello({ token }))
  const welcome = await c.next((frame) => frame.t === 'welcome' || frame.t === 'bye')
  assert.equal(welcome.t, 'welcome')
  return c
}

let next = 0
async function ask(c: LineClient, method: string, params: unknown): Promise<StudioParsedServerFrame & { t: 'res' }> {
  const id = `r${++next}`
  c.send({ t: 'req', id, method, params })
  return (await c.next((frame) => frame.t === 'res' && frame.id === id)) as StudioParsedServerFrame & { t: 'res' }
}

const errorOf = (frame: StudioParsedServerFrame) => (frame.t === 'res' && !frame.ok ? frame.error.code : null)
const resultOf = (frame: StudioParsedServerFrame) => (frame.t === 'res' && frame.ok ? frame.result : undefined)

/** Every keyed method, with params that are its documented shape. */
const CALLS: Record<keyof typeof STUDIO_FOLLOWED_METHODS, Record<string, unknown>> = {
  'conversation.askSideQuestion': { key: KEY, commandId: 'c-ask', questionId: 'q1', question: 'Why?' },
  'conversation.cancelSideQuestion': { questionId: 'q1' },
  'conversation.contextBreakdown': { key: KEY },
  'conversation.searchFiles': { key: KEY, query: 'app' },
  'conversation.listCommands': { key: KEY },
  'conversation.settle': { key: KEY, commandId: 'c-settle' },
  'conversation.visit': { key: KEY },
  'conversation.changesDiff': { key: KEY, selection: { kind: 'span' } },
  'conversation.changedFile': { key: KEY, selection: { kind: 'uncommitted' }, path: 'src/app.ts' },
}

test('the socket withholds no conversation capability but its handshake, its upload shrinking, and what it does not carry yet', async () => {
  const started = await serve()
  const c = await client(started.path, OWNER_TOKEN)
  c.send({ t: 'req', id: 'info', method: 'server.info' })
  const info = resultOf(await c.next((frame) => frame.t === 'res' && frame.id === 'info')) as {
    conversation: { capabilities: string[] }
  }
  for (const capability of [
    'conversation-lifecycle',
    'conversation-queued-sends',
    'conversation-scheduled-sends',
    'conversation-usage-limits',
    'conversation-subagents',
    'conversation-changes',
    'conversation-side-questions',
    'conversation-side-question-records',
    'conversation-context-breakdown',
    'conversation-file-search',
    'conversation-commands',
    'conversation-permanent-approvals',
  ])
    assert.ok(info.conversation.capabilities.includes(capability), capability)
  for (const capability of STUDIO_RPC_WITHHELD_CONVERSATION_CAPABILITIES)
    assert.equal(info.conversation.capabilities.includes(capability), false, capability)
  // A Studio whose host cannot serve them does not say it does.
  const bare = studioRpcConversationCapabilities(createFakeBackend())
  assert.equal(bare.includes('conversation-side-questions'), false)
  assert.equal(bare.includes('conversation-changes'), false)
  assert.ok(bare.includes('conversation-permanent-approvals'))
})

test('each keyed method reaches the host for an owner and a paired client that may operate', async () => {
  const started = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const paired = await client(
    started.path,
    pairFakeClient(started.auth, 'tablet', ['conversation:read', 'conversation:operate']),
  )
  for (const c of [owner, paired])
    for (const [method, params] of Object.entries(CALLS)) {
      const answer = await ask(c, method, { ...params, ...('commandId' in params ? { commandId: `${method}-${c === owner}` } : {}) })
      assert.equal(answer.ok, true, `${method}: ${JSON.stringify(answer)}`)
    }
  assert.deepEqual(
    started.calls.filter(([kind]) => kind === 'askSideQuestion'),
    [
      ['askSideQuestion', 'agent-1', 'owner', 'q1', 'Why?', []],
      ['askSideQuestion', 'agent-1', 'tablet', 'q1', 'Why?', []],
    ],
  )
  // The write says whose it was.
  assert.deepEqual(
    started.calls.filter(([kind]) => kind === 'settle').map((call) => call[3]),
    [true, false],
  )
})

test('a read-only grant reads the chat but is refused what runs its agent or writes its record', async () => {
  const started = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  for (const [method, params] of Object.entries(CALLS)) {
    const answer = await ask(reader, method, params)
    const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_METHOD_ACCESS]
    const reads = 'permissions' in access && access.permissions.every((permission) => permission === 'conversation:read')
    assert.equal(answer.ok, reads, method)
    if (!reads) assert.equal(errorOf(answer), 'scope_required', method)
    // What the server answers is what the package says a client may offer.
    assert.equal(studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, method), reads, method)
  }
  assert.deepEqual(
    Object.keys(CALLS).filter((method) => !studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, method)),
    ['conversation.askSideQuestion', 'conversation.settle', 'conversation.visit'],
  )
  // A refresh of the command list starts the chat's CLI: refused here, as
  // the lane's refresh was.
  const refresh = await ask(reader, 'conversation.listCommands', { key: KEY, refresh: true })
  assert.equal(errorOf(refresh), 'scope_required')
  assert.equal(started.calls.filter(([kind]) => kind === 'listCommands').length, 1)
})

test('a revoked client is refused every keyed method and topic', async () => {
  const started = await serve()
  const token = pairFakeClient(started.auth, 'gone', ['conversation:read', 'conversation:operate'])
  const c = await client(started.path, token)
  c.send({ t: 'sub', id: 'q', topic: 'conversation.queued', params: { key: KEY } })
  await c.next((frame) => frame.t === 'push')
  started.auth.revoke('gone')
  await c.closed
  const again = await connectLineClient(started.path)
  cleanups.push(() => again.close())
  again.send(hello({ token }))
  const bye = await again.next((frame) => frame.t === 'bye' || frame.t === 'welcome')
  assert.equal(bye.t, 'bye')
  for (const method of Object.keys(CALLS))
    assert.equal(studioGrantAllows({ owner: false, scopes: [] }, method), false, method)
  for (const topic of Object.keys(STUDIO_FOLLOWED_TOPICS))
    assert.equal(studioGrantAllowsTopic({ owner: false, scopes: [] }, topic), false, topic)
  // The watch it held was stopped with it.
  assert.ok(started.calls.some(([kind]) => kind === 'queued:stop'))
})

test('each per-chat topic pushes the lane’s own frame, now and on each change, until unsubscribed', async () => {
  const started = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  const frames: Record<string, unknown> = {
    'conversation.queued': { type: 'queued', key: KEY, messages: [] },
    'conversation.scheduled': { type: 'scheduled', key: KEY, messages: [] },
    'conversation.usageLimits': { type: 'usageLimits', key: KEY, notice: null, autoResume: false, limits: [] },
    'conversation.subagents': { type: 'subagents', key: KEY, subagents: [] },
    'conversation.changes': { type: 'changes', key: KEY, changes: null, revision: 'r1' },
  }
  assert.deepEqual(Object.keys(frames).sort(), Object.keys(STUDIO_FOLLOWED_TOPICS).sort())
  for (const [topic, first] of Object.entries(frames)) {
    reader.send({ t: 'sub', id: topic, topic, params: { key: KEY } })
    const pushed = await reader.next((frame) => frame.t === 'push' && frame.sub === topic)
    assert.deepEqual(pushed.t === 'push' && pushed.payload, first, topic)
  }
  started.followed.tell('changes', { changes: null, revision: 'r2' })
  const moved = await reader.next((frame) => frame.t === 'push' && frame.sub === 'conversation.changes')
  assert.deepEqual(moved.t === 'push' && moved.payload, { type: 'changes', key: KEY, changes: null, revision: 'r2' })

  reader.send({ t: 'unsub', id: 'conversation.changes' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(started.calls.some(([kind]) => kind === 'changes:stop'))
  started.followed.tell('changes', { changes: null, revision: 'r3' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(reader.frames.filter((frame) => frame.t === 'push' && frame.sub === 'conversation.changes').length, 0)
})

test('a per-chat topic names a chat this Studio has, and a folder only for an owner', async () => {
  const started = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  reader.send({ t: 'sub', id: 'nope', topic: 'conversation.queued', params: { key: { ...KEY, agentId: 'nobody' } } })
  const missing = await reader.next((frame) => frame.t === 'subFailed')
  assert.equal(missing.t === 'subFailed' && missing.code, 'not_found')
  reader.send({
    t: 'sub',
    id: 'folder',
    topic: 'conversation.subagents',
    params: { key: { ...KEY, workspaceRoot: '/Users/dev/other' } },
  })
  const folder = await reader.next((frame) => frame.t === 'subFailed')
  assert.equal(folder.t === 'subFailed' && folder.code, 'owner_required')
  // And a method the same.
  const named = await ask(reader, 'conversation.searchFiles', {
    key: { ...KEY, workspaceRoot: '/Users/dev/other' },
    query: 'app',
  })
  assert.equal(errorOf(named), 'owner_required')
  assert.equal(started.calls.filter(([kind]) => kind === 'searchFiles').length, 0)
})

test('a side question asked again under its command id is answered once; only its asker calls it off', async () => {
  const started = await serve()
  const tablet = await client(
    started.path,
    pairFakeClient(started.auth, 'tablet', ['conversation:read', 'conversation:operate']),
  )
  const params = {
    key: KEY,
    commandId: 'c1',
    questionId: 'q9',
    question: 'And then?',
    history: [{ question: 'Why?', answer: 'Because.' }],
  }
  const first = await ask(tablet, 'conversation.askSideQuestion', params)
  const second = await ask(tablet, 'conversation.askSideQuestion', params)
  assert.deepEqual(resultOf(first), { ok: true, answer: 'About And then?' })
  assert.deepEqual(resultOf(second), resultOf(first))
  assert.equal(started.calls.filter(([kind]) => kind === 'askSideQuestion').length, 1)
  // The same id for another question is refused.
  const other = await ask(tablet, 'conversation.askSideQuestion', { ...params, question: 'Something else?' })
  assert.equal(errorOf(other), 'command_id_conflict')

  await ask(tablet, 'conversation.cancelSideQuestion', { questionId: 'q9' })
  assert.deepEqual(started.calls.at(-1), ['cancelSideQuestion', 'tablet', 'q9'])

  // The lane's validator reads it: an empty question is no question.
  const empty = await ask(tablet, 'conversation.askSideQuestion', { ...params, commandId: 'c2', question: '  ' })
  assert.equal(errorOf(empty), 'invalid_params')
  // It is audited with the client that asked.
  assert.ok(started.audit.some((entry) => entry.tool === 'conversation.askSideQuestion' && entry.clientId === 'tablet'))
})

test('settle says when an agent is working; visit is not audited and carries no command id', async () => {
  const started = await serve()
  const tablet = await client(
    started.path,
    pairFakeClient(started.auth, 'tablet', ['conversation:read', 'conversation:operate']),
  )
  const busy = await ask(tablet, 'conversation.settle', { key: { ...KEY, agentId: 'busy' }, commandId: 's1' })
  assert.equal(errorOf(busy), 'conflict')
  assert.match(busy.t === 'res' && !busy.ok ? busy.error.message : '', /working/u)
  const back = await ask(tablet, 'conversation.settle', { key: KEY, commandId: 's2', settled: false })
  assert.deepEqual(resultOf(back), { settledAt: null })
  const gone = await ask(tablet, 'conversation.settle', { key: { ...KEY, agentId: 'nobody' }, commandId: 's3' })
  assert.equal(errorOf(gone), 'not_found')

  const visited = await ask(tablet, 'conversation.visit', { key: KEY, visitedAt: 1_500.7 })
  assert.deepEqual(resultOf(visited), { lastVisitedAt: 1_500 })
  assert.equal(started.audit.filter((entry) => entry.tool === 'conversation.visit').length, 0)
  assert.equal(started.audit.filter((entry) => entry.tool === 'conversation.settle').length, 3)
})

test('the changes reads name a step and a file it lists; anything else is refused', async () => {
  const started = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  const outside = await ask(reader, 'conversation.changedFile', {
    key: KEY,
    selection: { kind: 'span' },
    path: '../secrets.txt',
  })
  assert.equal(errorOf(outside), 'invalid_params')
  const unlisted = await ask(reader, 'conversation.changedFile', {
    key: KEY,
    selection: { kind: 'span' },
    path: 'elsewhere.txt',
  })
  assert.equal(errorOf(unlisted), 'not_found')
  const badStep = await ask(reader, 'conversation.changesDiff', { key: KEY, selection: { kind: 'commit', hash: 'x' } })
  assert.equal(errorOf(badStep), 'invalid_params')
})

test('a Studio whose host serves none of them answers each unavailable', async () => {
  const started = await startTestServer()
  cleanups.push(() => started.dispose())
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.equal(errorOf(await ask(owner, method, params)), 'unavailable', method)
  owner.send({ t: 'sub', id: 's', topic: 'conversation.queued', params: { key: KEY } })
  const failed = await owner.next((frame) => frame.t === 'subFailed')
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test('an approval that outlives the chat is taken from a client whose ceiling may allow a rule', async () => {
  const started = await serve()
  const loose = await client(
    started.path,
    pairFakeClient(started.auth, 'loose', ['conversation:read', 'conversation:operate'], 'auto'),
  )
  const strict = await client(
    started.path,
    pairFakeClient(started.auth, 'strict', ['conversation:read', 'conversation:operate'], 'none'),
  )
  const always = { key: KEY, requestId: 'req-1', decision: 'always' }
  assert.equal((await ask(loose, 'conversation.resolveApproval', { ...always, commandId: 'a1' })).ok, true)
  assert.deepEqual(started.backend.commands.at(-1)?.command, {
    kind: 'resolveApproval',
    requestId: 'req-1',
    decision: 'always',
  })
  assert.equal(errorOf(await ask(strict, 'conversation.resolveApproval', { ...always, commandId: 'a2' })), 'ceiling_exceeded')
})
