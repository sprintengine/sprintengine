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
import type { StudioChatBackend, StudioFollowedBackend } from './studio-rpc-types'
import { createStudioRpcRouter } from './studio-rpc-router'
import { studioWindowGrant } from './studio-frame-port'
import { studioRpcConversationCapabilities } from './studio-rpc-server'
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
    settle(workspaceId, settled, byOwner) {
      calls.push(['settle', workspaceId, settled, byOwner])
      if (workspaceId === 'ws-busy')
        return { ok: false, code: 'working', message: 'An agent in this chat is working. Settle it once it stops.' }
      if (workspaceId === 'ws-gone') return { ok: false, code: 'unknown_workspace', message: 'No such chat.' }
      return { ok: true, settledAt: settled ? 1_000 : null }
    },
    visit(workspaceId, visitedAt, byOwner) {
      calls.push(['visit', workspaceId, visitedAt, byOwner])
      return { ok: true, lastVisitedAt: visitedAt ?? 2_000 }
    },
    async picture(key, ref) {
      calls.push(['picture', key.agentId, ref])
      if ('toolUseId' in ref && ref.toolUseId === 'no-picture')
        return { ok: false, code: 'not_found', message: 'That picture is not in this conversation.' }
      return { ok: true, mediaType: 'image/png', bytes: Buffer.from('png bytes') }
    },
    async stageUploads(key, clientId, uploads) {
      calls.push([
        'stageUploads',
        key.agentId,
        clientId,
        uploads.map((upload) => [upload.purpose, upload.name ?? null, upload.bytes.toString()]),
      ])
      await stagingHeld
      return { ok: true, ids: uploads.map((_upload, index) => `host-${clientId}-${staged++}-${index}`) }
    },
    // The host carried out a send under this id before (a server since
    // restarted, its uploads gone with it): held, or in the chat's log.
    async keepFile(clientId, file) {
      calls.push(['keepFile', clientId, file.name])
      return { path: `/kept/${file.name}`, discard: () => undefined }
    },
    async sentBefore(key, clientId, commandId) {
      calls.push(['sentBefore', key.agentId, clientId, commandId])
      return commandId.endsWith('sent-before-restart')
    },
  }
}
let staged = 0
/** What the fake host's staging waits on: a test holds it to send again mid-staging. */
let stagingHeld: Promise<void> = Promise.resolve()

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
  'conversation.fork': { key: KEY, commandId: 'c-fork', newAgentId: 'agent-2', side: 'assistant', turnId: 't1' },
  'conversation.askSideQuestion': { key: KEY, commandId: 'c-ask', questionId: 'q1', question: 'Why?' },
  'conversation.cancelSideQuestion': { questionId: 'q1' },
  'conversation.contextBreakdown': { key: KEY },
  'conversation.searchFiles': { key: KEY, query: 'app' },
  'conversation.listCommands': { key: KEY },
  'conversation.settle': { workspaceId: KEY.workspaceId, commandId: 'c-settle' },
  'conversation.visit': { workspaceId: KEY.workspaceId },
  'conversation.changesDiff': { key: KEY, selection: { kind: 'span' } },
  'conversation.changedFile': { key: KEY, selection: { kind: 'uncommitted' }, path: 'src/app.ts' },
  'conversation.picture': { key: KEY, toolUseId: 'tool-1' },
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
    'conversation-quote-tokens',
    'conversation-fork',
    'conversation-images',
    'conversation-message-images',
    'conversation-message-files',
    'conversation-queued-attachments',
  ])
    assert.ok(info.conversation.capabilities.includes(capability), capability)
  // A Studio whose host cannot serve them does not say it does.
  const bare = studioRpcConversationCapabilities(createFakeBackend())
  assert.equal(bare.includes('conversation-side-questions'), false)
  assert.equal(bare.includes('conversation-changes'), false)
  assert.equal(bare.includes('conversation-images'), false)
  assert.equal(bare.includes('conversation-message-files'), false)
  assert.ok(bare.includes('conversation-permanent-approvals'))
})

test('a fork is the host’s, joined to the chat’s records, and answered with where it is and what it is called', async () => {
  const started = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  // A fork is a new chat: `conversation:create` (a device's operate carries it).
  const paired = await client(
    started.path,
    pairFakeClient(started.auth, 'tablet', ['conversation:read', 'conversation:operate', 'conversation:create']),
  )
  const reader = await client(started.path, pairFakeClient(started.auth, 'watch', ['conversation:read']))
  const fork = { key: KEY, commandId: 'c-fork', newAgentId: 'agent-2', side: 'user', turnSeq: 3, title: 'Mine' }
  for (const c of [owner, paired]) {
    const answer = await ask(c, 'conversation.fork', fork)
    assert.deepEqual(resultOf(answer), {
      ok: true,
      address: { environmentId: 'env-test', chatId: 'ws-1', agentId: 'agent-2' },
      name: 'Atlas (fork)',
    })
  }
  // The host's command, under each client's own id; the Studio names it, so
  // a title an older client sends is not carried.
  const forks = started.backend.commands.filter(({ command }) => command.kind === 'fork')
  assert.deepEqual(
    forks.map(({ clientId, command }) => [clientId, command]),
    [
      ['owner', { kind: 'fork', newAgentId: 'agent-2', side: 'user', turnSeq: 3 }],
      ['tablet', { kind: 'fork', newAgentId: 'agent-2', side: 'user', turnSeq: 3 }],
    ],
  )
  // Asked again after a dropped connection: the same fork, not a second.
  const again = await ask(owner, 'conversation.fork', fork)
  assert.equal((resultOf(again) as { name?: string }).name, 'Atlas (fork)')
  assert.equal(started.backend.commands.filter(({ command }) => command.kind === 'fork').length, 2)
  // Following a chat is not starting one.
  assert.equal(errorOf(await ask(reader, 'conversation.fork', { ...fork, commandId: 'c-fork-2' })), 'scope_required')
})

test('a fork the host made but did not name is refused, not answered without a name', async () => {
  const started = await serve()
  const command = started.backend.command.bind(started.backend)
  started.backend.command = async (key, clientId, commandId, carried, fingerprint) =>
    carried.kind === 'fork' ? { ok: true } : command(key, clientId, commandId, carried, fingerprint)
  const owner = await client(started.path, OWNER_TOKEN)
  const answer = await ask(owner, 'conversation.fork', {
    key: KEY,
    commandId: 'c-fork',
    newAgentId: 'agent-2',
    side: 'assistant',
    turnId: 't1',
  })
  assert.equal(errorOf(answer), 'unavailable')
})

test('each keyed method reaches the host for an owner and a paired client that may operate', async () => {
  const started = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const paired = await client(
    started.path,
    pairFakeClient(started.auth, 'tablet', ['conversation:read', 'conversation:operate', 'conversation:create']),
  )
  for (const c of [owner, paired])
    for (const [method, params] of Object.entries(CALLS)) {
      const answer = await ask(c, method, {
        ...params,
        ...('commandId' in params ? { commandId: `${method}-${c === owner}` } : {}),
      })
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
    const reads =
      'permissions' in access && access.permissions.every((permission) => permission === 'conversation:read')
    assert.equal(answer.ok, reads, method)
    if (!reads) assert.equal(errorOf(answer), 'scope_required', method)
    // What the server answers is what the package says a client may offer.
    assert.equal(studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, method), reads, method)
  }
  assert.deepEqual(
    Object.keys(CALLS).filter((method) => !studioGrantAllows({ owner: false, scopes: ['conversation:read'] }, method)),
    ['conversation.fork', 'conversation.askSideQuestion', 'conversation.settle', 'conversation.visit'],
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
  const busy = await ask(tablet, 'conversation.settle', { workspaceId: 'ws-busy', commandId: 's1' })
  assert.equal(errorOf(busy), 'conflict')
  assert.match(busy.t === 'res' && !busy.ok ? busy.error.message : '', /working/u)
  const back = await ask(tablet, 'conversation.settle', {
    workspaceId: KEY.workspaceId,
    commandId: 's2',
    settled: false,
  })
  assert.deepEqual(resultOf(back), { settledAt: null })
  const gone = await ask(tablet, 'conversation.settle', { workspaceId: 'ws-gone', commandId: 's3' })
  assert.equal(errorOf(gone), 'not_found')

  const visited = await ask(tablet, 'conversation.visit', { workspaceId: KEY.workspaceId, visitedAt: 1_500.7 })
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
  // A fork is a command every host takes; one that keeps no records refuses it in words.
  for (const [method, params] of Object.entries(CALLS))
    if (method !== 'conversation.fork') assert.equal(errorOf(await ask(owner, method, params)), 'unavailable', method)
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
  assert.equal(
    errorOf(await ask(strict, 'conversation.resolveApproval', { ...always, commandId: 'a2' })),
    'ceiling_exceeded',
  )
})

test('a connection held to known folders names a chat by a folder Studio knows, or not at all', async () => {
  const calls: Calls = []
  const backend = createFakeBackend()
  backend.followed = fakeFollowed(calls)
  const router = createStudioRpcRouter({
    backend,
    chat: () => ({ isKnownFolder: async (path: string) => path === '/Users/dev/app' }) as unknown as StudioChatBackend,
    info: () => ({}) as never,
  })
  cleanups.push(() => router.close())
  const grant = studioWindowGrant()
  const tailnet = { connectionId: 'w1', slot: 1, ownWindow: false, knownFoldersOnly: true }
  const search = (workspaceRoot: string) =>
    router.handle(grant, 'conversation.searchFiles', { key: { ...KEY, workspaceRoot }, query: 'app' }, tailnet)
  const commands = (workspaceRoot: string) =>
    router.handle(grant, 'conversation.listCommands', { key: { ...KEY, workspaceRoot }, refresh: true }, tailnet)
  assert.ok((await search('/Users/dev/app')).ok)
  const elsewhere = await search('/Users/dev')
  assert.equal(!elsewhere.ok && elsewhere.error.code, 'not_found')
  const ran = await commands('/etc')
  assert.equal(!ran.ok && ran.error.code, 'not_found')
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['searchFiles'],
  )
  // An owner on this machine names any folder, as for every keyed read.
  const loopback = { connectionId: 'w2', slot: 2, ownWindow: false }
  assert.ok(
    (
      await router.handle(
        grant,
        'conversation.searchFiles',
        { key: { ...KEY, workspaceRoot: '/Users/dev' }, query: 'a' },
        loopback,
      )
    ).ok,
  )
})

/** Stage `text` as one upload of `purpose` on the client's connection; answers its id. */
async function upload(c: LineClient, text: string, purpose: 'picture' | 'attachment'): Promise<string> {
  const begun = await ask(c, 'uploads.begin', {
    mediaType: purpose === 'picture' ? 'image/png' : 'text/plain',
    byteLength: Buffer.byteLength(text),
    purpose,
    name: purpose === 'picture' ? 'shot.png' : 'notes.txt',
  })
  const { uploadId } = resultOf(begun) as { uploadId: string }
  const appended = await ask(c, 'uploads.append', {
    uploadId,
    offset: 0,
    dataBase64: Buffer.from(text).toString('base64'),
  })
  assert.equal(appended.ok, true, JSON.stringify(appended))
  return uploadId
}

test('a keyed send carries the pictures and files its client staged, made the chat’s once per command id', async () => {
  const started = await serve()
  const phone = await client(
    started.path,
    pairFakeClient(started.auth, 'phone', ['conversation:read', 'conversation:operate']),
  )
  // A tiny PNG's bytes are not needed here: the host stages what it is given.
  const picture = await upload(phone, 'picture', 'picture')
  const file = await upload(phone, 'file body', 'attachment')
  const sent = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'with-both',
    message: 'Look at these',
    uploadIds: [picture, file],
  })
  assert.equal(sent.ok, true, JSON.stringify(sent))
  const staging = started.calls.filter(([kind]) => kind === 'stageUploads')
  assert.deepEqual(staging, [
    [
      'stageUploads',
      'agent-1',
      'phone',
      [
        ['picture', 'shot.png', 'picture'],
        ['attachment', 'notes.txt', 'file body'],
      ],
    ],
  ])
  const carried = started.backend.commands.at(-1)!
  assert.equal(carried.command.kind, 'send')
  const hostIds = (carried.command as { uploadIds?: string[] }).uploadIds!
  assert.equal(hostIds.length, 2)
  assert.ok(hostIds.every((id) => id.startsWith('host-phone-')))
  // The same send again (its answer lost with the connection) names the same
  // host ids, and asks nothing of the uploads it already spent.
  const again = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'with-both',
    message: 'Look at these',
    uploadIds: [picture, file],
  })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(started.calls.filter(([kind]) => kind === 'stageUploads').length, 1)
  // Spent uploads go with no other send.
  const reused = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'another',
    message: 'Again?',
    uploadIds: [picture],
  })
  assert.equal(errorOf(reused), 'invalid_params')
  // Another client's upload is not this one's to send.
  const other = await client(
    started.path,
    pairFakeClient(started.auth, 'other', ['conversation:read', 'conversation:operate']),
  )
  const theirs = await upload(other, 'theirs', 'picture')
  const borrowed = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'borrowed',
    message: 'Not mine',
    uploadIds: [theirs],
  })
  assert.equal(errorOf(borrowed), 'not_found')
})

test('a send sent again while its pictures are still being staged is staged once, under the same host ids', async () => {
  const started = await serve()
  const phone = await client(
    started.path,
    pairFakeClient(started.auth, 'phone', ['conversation:read', 'conversation:operate']),
  )
  const picture = await upload(phone, 'picture', 'picture')
  let release = (): void => undefined
  stagingHeld = new Promise<void>((resolve) => (release = resolve))
  try {
    const send = { key: KEY, commandId: 'mid-staging', message: 'Look', uploadIds: [picture] }
    const first = ask(phone, 'conversation.send', send)
    for (let tries = 0; !started.calls.some(([kind]) => kind === 'stageUploads') && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    // The phone's socket dropped and it sends again before the first answer.
    const again = ask(phone, 'conversation.send', send)
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const answers = await Promise.all([first, again])
    for (const answer of answers) assert.equal(answer.ok, true, JSON.stringify(answer))
  } finally {
    release()
    stagingHeld = Promise.resolve()
  }
  assert.equal(started.calls.filter(([kind]) => kind === 'stageUploads').length, 1)
  const sends = started.backend.commands.filter((carried) => carried.command.kind === 'send')
  const ids = sends.map((carried) => JSON.stringify((carried.command as { uploadIds?: string[] }).uploadIds))
  assert.equal(new Set(ids).size, 1, ids.join(' '))
})

test('a chat’s picture is read by its step or the ref its message recorded, never by a path', async () => {
  const started = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  const step = await ask(reader, 'conversation.picture', { key: KEY, toolUseId: 'tool-1' })
  assert.deepEqual(resultOf(step), { mediaType: 'image/png', dataBase64: Buffer.from('png bytes').toString('base64') })
  const sent = await ask(reader, 'conversation.picture', { key: KEY, attachment: 'ref-1' })
  assert.equal(sent.ok, true)
  assert.equal(errorOf(await ask(reader, 'conversation.picture', { key: KEY, toolUseId: 'no-picture' })), 'not_found')
  assert.equal(
    errorOf(await ask(reader, 'conversation.picture', { key: KEY, toolUseId: 'tool-1', attachment: 'ref-1' })),
    'invalid_params',
  )
  assert.equal(errorOf(await ask(reader, 'conversation.picture', { key: KEY, path: '/etc/passwd' })), 'invalid_params')
  assert.deepEqual(
    started.calls.filter(([kind]) => kind === 'picture').map((call) => call[2]),
    [{ toolUseId: 'tool-1' }, { attachment: 'ref-1' }, { toolUseId: 'no-picture' }],
  )
})

test('a keyed send resent after a restart, its uploads gone, is answered from what the host kept, not refused for them', async () => {
  const started = await serve()
  const phone = await client(
    started.path,
    pairFakeClient(started.auth, 'phone', ['conversation:read', 'conversation:operate']),
  )
  // The uploads it named went with the server that took the first attempt.
  const resent = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'sent-before-restart',
    message: 'Look at these',
    uploadIds: ['gone-picture', 'gone-file'],
  })
  assert.equal(resent.ok, true, JSON.stringify(resent))
  assert.equal(started.calls.filter(([kind]) => kind === 'stageUploads').length, 0, 'nothing staged for it')
  const carried = started.backend.commands.at(-1)!
  assert.equal(carried.command.kind, 'send')
  assert.equal((carried.command as { uploadIds?: string[] }).uploadIds, undefined)
  // A send never carried out still needs its uploads, and is refused without them.
  const fresh = await ask(phone, 'conversation.send', {
    key: KEY,
    commandId: 'never-sent',
    message: 'Look at these',
    uploadIds: ['gone-picture'],
  })
  assert.equal(!fresh.ok && fresh.error.code, 'not_found')
  phone.close()
})
