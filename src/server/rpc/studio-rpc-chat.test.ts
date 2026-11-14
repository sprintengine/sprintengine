import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import {
  STUDIO_CHAT_CAPABILITIES,
  STUDIO_SCOPES,
  createStudioChunkAssembler,
  parseStudioServerFrame,
  type StudioParsedServerFrame,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationEvent, ConversationSendTurnInput } from '../../shared/conversation-runtime'
import { CONVERSATION_SESSION_NOT_FOUND } from '../../shared/conversation-runtime'
import {
  createTicketAuthenticator,
  framePortStream,
  mintStudioTicket,
  studioWindowGrant,
  type StudioFramePort,
} from './studio-frame-port'
import { createStudioRpcRouter } from './studio-rpc-router'
import { createStudioUploads } from './studio-uploads'
import { createStudioFileSystem } from '../files/studio-file-system'
import {
  OWNER_TOKEN,
  connectLineClient,
  createFakeBackend,
  hello,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'
import type { StudioChatBackend } from './studio-rpc-types'
type StudioGrant = Parameters<ReturnType<typeof createStudioRpcRouter>['handle']>[0]

// The chat surface and the window's way in: what Studio's own chat view asks
// of the RPC beside the conversation lane, held to owners, answered as its IPC
// answers it, and reached over a port with a one-time ticket.

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

type ChatCalls = {
  sends: ConversationSendTurnInput[]
  reverts: number
  commandListeners: Set<(catalog: ConversationCommandCatalog) => void>
  controls: string[]
  releasedHistory: number[]
  lifecycleListeners: Set<(event: ConversationEvent) => void>
  /** Sessions the runtime no longer holds: its server restarted since they were started. */
  lostSessions: Set<string>
}

function fakeChat(): StudioChatBackend & { calls: ChatCalls } {
  const calls: ChatCalls = {
    sends: [],
    reverts: 0,
    commandListeners: new Set(),
    controls: [],
    releasedHistory: [],
    lifecycleListeners: new Set(),
    lostSessions: new Set(),
  }
  const session = {
    sessionId: 's1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'mock',
    modelId: 'mock',
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    calls,
    startSession: async () => ({ ok: true, session }),
    sendTurn: async (input) => {
      if (calls.lostSessions.has(input.sessionId))
        return { ok: false, code: CONVERSATION_SESSION_NOT_FOUND, message: 'Conversation session is invalid.' }
      calls.sends.push(input)
      return { ok: true, session }
    },
    // A send the runtime has carried out holds a receipt under its id, in
    // the chat's log, whichever of its sessions asks; a session it no longer
    // holds (its server restarted) is none to ask of.
    commandReceipt: async ({ sessionId, commandId }) =>
      calls.lostSessions.has(sessionId)
        ? 'no_session'
        : calls.sends.some((send) => send.commandId === commandId)
          ? 'kept'
          : 'none',
    interrupt: async () => ({ ok: true, session }),
    respond: async () => ({ ok: true, session }),
    setPermission: async () => ({ ok: true, session }),
    setModel: async () => ({ ok: true, session }),
    revert: async () => {
      calls.reverts++
      return { ok: true, files: [], reverted: true }
    },
    rewind: async () => ({ ok: true }),
    handoff: async () => ({ ok: true, path: '/Users/dev/handoff.md' }),
    attachment: async () => ({ ok: false, message: 'No such picture.' }),
    exportSource: async () => ({ ok: false, code: 'not_found', message: 'This chat could not be found.' }),
    planDocument: async () => ({ ok: true, path: '/Users/dev/plan.md' }),
    commands: async (input) => ({ cli: input.cli, cwd: input.cwd, commands: [], fetchedAt: 1 }),
    onCommandsChanged: (listener) => {
      calls.commandListeners.add(listener)
      return () => calls.commandListeners.delete(listener)
    },
    providers: async () => ({ ok: true, providers: [] }),
    providerModels: async () => ({ ok: false, message: 'No catalog.' }),
    secretStatus: async () => ({ ok: false, message: 'No secret.' }),
    listSessions: async () => ({ ok: true, sessions: [session] }),
    stopSession: async (input) => {
      calls.controls.push(`stop:${input.sessionId}:${input.commandId}`)
      return { ok: true, session }
    },
    suspendSession: async (input) => {
      calls.controls.push(`suspend:${input.sessionId}`)
      return { ok: true, session }
    },
    mcpServerAction: async (input) => {
      calls.controls.push(`mcp:${input.serverId}:${input.action}`)
      return { ok: true }
    },
    stopSubagent: async (input) => {
      calls.controls.push(`stop-subagent:${input.toolUseId}`)
      return { ok: true, session }
    },
    messageSubagent: async (input) => {
      calls.controls.push(`message-subagent:${input.toolUseId}:${input.message}`)
      return { ok: true, session }
    },
    askSideQuestion: async (input) => {
      calls.controls.push(`side-question:${input.requestId}:${input.history?.length ?? 0}`)
      return { ok: true, answer: 'Because.' }
    },
    cancelSideQuestion: async (input) => {
      calls.controls.push(`cancel-side-question:${input.requestId}`)
      return { ok: true }
    },
    contextBreakdown: async () => ({ ok: false, reason: 'not-running', message: 'No agent yet.' }),
    terminalHandoff: async (input) => {
      calls.controls.push(`terminal-handoff:${'sessionId' in input ? input.sessionId : input.agentId}`)
      return { ok: true, workspaceId: 'ws-1', agentId: 'terminal-1' }
    },
    threads: async (input) => {
      calls.controls.push(`threads:${input.workspaceRoot}`)
      return { ok: true, threads: [] }
    },
    searchHistory: async (_slot, input) => {
      calls.controls.push(`search:${input.workspaceRoot}:${input.query}`)
      return { ok: true, hits: [{ agentId: 'agent-1', seq: 3, snippet: input.query }] }
    },
    cancelHistorySearch: (_slot, requestId) => void calls.controls.push(`cancel-search:${requestId}`),
    releaseHistorySearches: (slot) => void calls.releasedHistory.push(slot),
    approvalRules: async () => ({ ok: true, rules: [] }),
    revokeApprovalRule: async (ruleId) => {
      calls.controls.push(`revoke:${ruleId}`)
      return { ok: true }
    },
    signIn: async () => ({ ok: true, commandLine: 'claude login', cwd: '/Users/dev', platform: 'darwin' }),
    setSecret: async (input) => {
      calls.controls.push(`set-secret:${input.providerId}`)
      return {
        ok: true,
        status: {
          providerId: input.providerId,
          configured: true,
          source: 'settings',
          persistence: 'encrypted',
          encryptionAvailable: true,
          label: 'Key',
        },
      }
    },
    clearSecret: async (input) => {
      calls.controls.push(`clear-secret:${input.providerId}`)
      return {
        ok: true,
        status: {
          providerId: input.providerId,
          configured: false,
          source: 'none',
          persistence: 'encrypted',
          encryptionAvailable: true,
          label: 'Key',
        },
      }
    },
    onLifecycleEvent: (listener) => {
      calls.lifecycleListeners.add(listener)
      return () => calls.lifecycleListeners.delete(listener)
    },
  }
}

/** A client's end of an in-memory connection, reading frames as a client does. */
type PortClient = {
  send(frame: unknown): void
  next(match?: (frame: StudioParsedServerFrame) => boolean): Promise<StudioParsedServerFrame>
  close(): void
  closed: Promise<void>
}

function portPair(): { server: StudioFramePort; client: PortClient } {
  const toClient: Array<(frame: string) => void> = []
  const toServer: Array<(frame: string) => void> = []
  const closeListeners: Array<() => void> = []
  let isClosed = false
  let closedResolve!: () => void
  const closed = new Promise<void>((resolve) => (closedResolve = resolve))
  const end = () => {
    if (isClosed) return
    isClosed = true
    closedResolve()
    for (const listener of closeListeners.splice(0)) queueMicrotask(listener)
  }
  const frames: StudioParsedServerFrame[] = []
  const waiters: Array<() => void> = []
  const assembler = createStudioChunkAssembler()
  const accept = (json: string) => {
    const frame = parseStudioServerFrame(JSON.parse(json))
    if (!frame) throw new Error(`Unreadable frame: ${json.slice(0, 200)}`)
    if (frame.t === 'chunk') {
      const step = assembler.push(frame)
      if (step.kind === 'frame') accept(step.json)
      return
    }
    frames.push(frame)
    for (const wake of waiters.splice(0)) wake()
  }
  toClient.push(accept)
  return {
    server: {
      post: (frame) => {
        if (!isClosed) queueMicrotask(() => toClient.forEach((listener) => listener(frame)))
      },
      onFrame: (listener) => void toServer.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
      close: end,
    },
    client: {
      send: (frame) => {
        if (!isClosed) queueMicrotask(() => toServer.forEach((listener) => listener(JSON.stringify(frame))))
      },
      async next(match = () => true) {
        const deadline = Date.now() + 5_000
        for (;;) {
          const index = frames.findIndex(match)
          if (index !== -1) return frames.splice(index, 1)[0]
          if (Date.now() > deadline) throw new Error(`No matching frame; saw ${JSON.stringify(frames).slice(0, 400)}`)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20)
            waiters.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        }
      },
      close: end,
      closed,
    },
  }
}

const isT =
  <T extends StudioParsedServerFrame['t']>(t: T) =>
  (frame: StudioParsedServerFrame) =>
    frame.t === t
const isRes = (id: string) => (frame: StudioParsedServerFrame) => frame.t === 'res' && frame.id === id

async function served(input: { chat?: ReturnType<typeof fakeChat> | null } = {}) {
  const chat = input.chat === undefined ? fakeChat() : input.chat
  // A host that keeps files sent with a session's message, as every Studio's does.
  const backend = createFakeBackend()
  backend.followed = {
    ...backend.followed,
    keepFile: async (_clientId, file) => ({ path: `/kept/${file.name}`, discard: () => undefined }),
  }
  const started = await startTestServer(chat ? { chat, backend } : { backend })
  disposers.push(started.dispose)
  return { ...started, chat }
}

/** A window's connection as the window listener attaches one: admitted by its ticket, as the app's own view. */
async function windowClient(server: Awaited<ReturnType<typeof served>>['server']): Promise<PortClient> {
  const { server: serverEnd, client } = portPair()
  const ticket = mintStudioTicket()
  server.attach(framePortStream(serverEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
  client.send(hello({ token: ticket }, { client: { name: 'Studio window' } }))
  const welcome = await client.next(isT('welcome'))
  assert.equal(welcome.t === 'welcome' && welcome.grant.owner, true)
  return client
}

async function socketClient(path: string, token: string): Promise<LineClient> {
  const client = await connectLineClient(path)
  client.send(hello({ token }))
  await client.next(isT('welcome'))
  return client
}

async function ask(client: PortClient | LineClient, id: string, method: string, params: unknown = {}) {
  client.send({ t: 'req', id, method, params })
  const answer = await client.next(isRes(id))
  if (answer.t !== 'res') throw new Error('not a response')
  return answer
}

test('a window ticket says one hello, once, within thirty seconds, and is no other credential', async () => {
  const now = { at: 0 }
  const ticket = mintStudioTicket()
  const auth = createTicketAuthenticator(ticket, { now: () => now.at })
  assert.match(ticket, /^[\x21-\x7e]{16,256}$/)
  assert.equal(auth.authenticate({ token: 'seticket_wrongwrongwrongwrong' }, { name: 'w' }).ok, false)
  assert.equal(auth.authenticate({ pairingCode: ticket }, { name: 'w' }).ok, false)
  assert.equal(auth.grantFor('owner'), null)
  const first = auth.authenticate({ token: ticket }, { name: 'w' })
  assert.equal(first.ok && first.grant.owner, true)
  assert.equal(auth.grantFor('owner')?.owner, true)
  assert.equal(auth.authenticate({ token: ticket }, { name: 'w' }).ok, false, 'a ticket is good once')
  const late = createTicketAuthenticator(ticket, { now: () => now.at })
  now.at = 30_001
  assert.equal(late.authenticate({ token: ticket }, { name: 'w' }).ok, false, 'and for thirty seconds')
  // A hello that presents anything else over a window's socket is the window
  // listener's to refuse (studio-window-listener.test.ts).
})

test('the welcome names the chat capabilities only where there is a chat surface', async () => {
  const withChat = await served()
  const owner = await connectLineClient(withChat.path)
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next(isT('welcome'))
  for (const capability of STUDIO_CHAT_CAPABILITIES)
    assert.ok(welcome.t === 'welcome' && welcome.capabilities.includes(capability), capability)
  owner.close()
  const without = await served({ chat: null })
  const other = await connectLineClient(without.path)
  other.send(hello({ token: OWNER_TOKEN }))
  const bare = await other.next(isT('welcome'))
  for (const capability of STUDIO_CHAT_CAPABILITIES)
    assert.ok(bare.t === 'welcome' && !bare.capabilities.includes(capability), capability)
  const refused = await ask(other, 'r1', 'session.list')
  assert.equal(!refused.ok && refused.error.code, 'unavailable')
  other.close()
})

test('a paired app reaches the chat surface by its scopes; a conversation’s folder stays an owner’s', async () => {
  const { path, auth, backend, chat } = await served()
  const token = pairFakeClient(auth, 'app', ['conversation:read', 'conversation:operate', 'conversation:create'])
  const app = await socketClient(path, token)
  const send = await ask(app, 's1', 'session.send', { commandId: 'c1', sessionId: 's1', message: 'hi' })
  assert.equal(send.ok, true)
  assert.equal(chat!.calls.sends.length, 1, 'the send reached the runtime')
  const folder = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/elsewhere' }
  const earlier = await ask(app, 'e1', 'conversation.loadEarlier', { key: folder, beforeCursor: 3 })
  assert.equal(!earlier.ok && earlier.error.code, 'owner_required')
  app.send({ t: 'sub', id: 'sub-1', topic: 'conversation.session', params: { key: folder } })
  const failed = await app.next(isT('subFailed'))
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
  // The `/` lists follow by conversation:read.
  app.send({ t: 'sub', id: 'sub-2', topic: 'conversation.commands', params: {} })
  for (let tries = 0; chat!.calls.commandListeners.size === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const catalog = { cli: 'claude-code', cwd: '/Users/dev/app', commands: [], fetchedAt: 2 }
  for (const listener of chat!.calls.commandListeners) listener(catalog)
  const pushed = await app.next((frame) => frame.t === 'push' || frame.t === 'subFailed')
  assert.equal(pushed.t, 'push')
  // An owner's folder is followed as named, not resolved by its workspace.
  const owner = await socketClient(path, OWNER_TOKEN)
  backend.emit('agent-1', 'user_message', { text: 'hello' })
  owner.send({ t: 'sub', id: 'sub-3', topic: 'conversation.session', params: { key: { ...folder } } })
  const snapshot = await owner.next((frame) => frame.t === 'frame' && frame.frame.type === 'snapshot')
  assert.equal(snapshot.t === 'frame' && snapshot.sub, 'sub-3')
  app.close()
  owner.close()
})

// One grant of each kind against the router, with a chat surface behind it
// that answers everything: what each reaches is what the protocol's table
// says it reaches (`studioGrantAllows`), and what it names on this disk is
// held by the router's rules on params.
function grantsRouter() {
  const chat: StudioChatBackend & { calls: ChatCalls } = {
    ...fakeChat(),
    isKnownFolder: async (path) => path === '/Users/dev/app' || path.startsWith('/Users/dev/app/'),
  }
  const uploads = createStudioUploads()
  disposers.push(async () => uploads.close())
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    uploads,
  })
  disposers.push(async () => router.close())
  const context = { connectionId: 'c1', slot: 1, ownWindow: false }
  const grant = (owner: boolean, scopes: StudioGrant['scopes']): StudioGrant => ({
    clientId: owner ? 'owner' : 'app',
    name: owner ? 'Owner' : 'App',
    owner,
    scopes,
    ceiling: 'bypass',
  })
  return {
    chat,
    owner: grant(true, [...STUDIO_SCOPES]),
    paired: grant(false, [...STUDIO_SCOPES]),
    readOnly: grant(false, ['conversation:read']),
    handle: (asking: StudioGrant, method: string, params: unknown) =>
      router.handle(asking, method as never, params as never, context),
  }
}

const code = (answer: { ok: boolean; error?: { code: string } }) => (answer.ok ? 'ok' : answer.error!.code)

test('a paired grant reaches every chat control by its scopes; only a terminal here and a CLI’s sign-in are an owner’s', async () => {
  const { owner, paired, handle } = grantsRouter()
  const calls: Array<[string, unknown]> = [
    ['session.send', { commandId: 'c1', sessionId: 's1', message: 'hi' }],
    ['session.list', {}],
    ['session.suspend', { commandId: 'c2', sessionId: 's1' }],
    ['session.mcpServerAction', { commandId: 'c3', sessionId: 's1', serverId: 'srv', action: 'reconnect' }],
    ['conversation.revert', { commandId: 'c4', key: { workspaceId: 'ws-1', agentId: 'agent-1' }, turnSeq: 1 }],
    ['providers.list', {}],
    ['providers.setSecret', { commandId: 'c5', providerId: 'p', value: 'sk-test' }],
    ['conversation.revokeApprovalRule', { commandId: 'c6', ruleId: 'rule-1' }],
    ['conversation.approvalRules', {}],
  ]
  for (const [method, params] of calls) assert.equal(code(await handle(paired, method, params)), 'ok', method)
  for (const [method, params] of [
    ['session.terminalHandoff', { commandId: 'c7', sessionId: 's1' }],
    ['providers.signIn', { providerId: 'p' }],
  ] as const) {
    assert.equal(code(await handle(paired, method, params)), 'owner_required', method)
    assert.equal(code(await handle(owner, method, params)), 'ok', method)
  }
})

test('whoever may drive the chats may revoke an always-allow rule: it only makes them ask again', async () => {
  const { handle } = grantsRouter()
  const driver: StudioGrant = {
    clientId: 'phone',
    name: 'Phone',
    owner: false,
    scopes: ['conversation:operate'],
    ceiling: 'bypass',
  }
  assert.equal(
    code(await handle(driver, 'conversation.revokeApprovalRule', { commandId: 'r1', ruleId: 'rule-1' })),
    'ok',
  )
  assert.equal(
    code(await handle(driver, 'providers.setSecret', { commandId: 'r2', providerId: 'p', value: 'sk' })),
    'scope_required',
  )
})

test('a read-only grant follows chats and is refused every method that needs more', async () => {
  const { readOnly, handle, chat } = grantsRouter()
  assert.equal(code(await handle(readOnly, 'session.list', {})), 'ok')
  assert.equal(code(await handle(readOnly, 'conversation.approvalRules', {})), 'ok')
  for (const [method, params] of [
    ['session.send', { commandId: 'c1', sessionId: 's1', message: 'hi' }],
    ['session.stop', { commandId: 'c2', sessionId: 's1' }],
    ['providers.setSecret', { commandId: 'c3', providerId: 'p', value: 'sk-test' }],
    ['providers.list', {}],
    ['files.search', { rootPath: '/Users/dev/app', query: 'a' }],
    ['conversation.revokeApprovalRule', { commandId: 'c4', ruleId: 'rule-1' }],
  ] as const)
    assert.equal(code(await handle(readOnly, method, params)), 'scope_required', method)
  assert.equal(chat.calls.sends.length, 0)
})

test('a client that is not an owner reads the always-allow rules by project, never by folder', async () => {
  const { owner, readOnly, handle, chat } = grantsRouter()
  const rules = [
    {
      id: 'rule-1',
      workspaceRoot: '/Users/dev/app',
      toolKind: 'file_edit' as const,
      toolName: 'Write',
      matcher: { type: 'path' as const, prefix: '/Users/dev/app' },
      label: 'Write: files within /Users/dev/app except .git',
      createdAt: 1,
    },
    {
      id: 'rule-2',
      workspaceRoot: '/Users/dev/app',
      toolKind: 'command' as const,
      toolName: 'Bash',
      matcher: { type: 'command' as const, program: 'npm', subcommand: 'test' },
      label: 'Bash: npm test',
      createdAt: 2,
    },
  ]
  chat.approvalRules = async () => ({ ok: true, rules })
  const mine = await handle(owner, 'conversation.approvalRules', {})
  assert.deepEqual(mine.ok && mine.result, { ok: true, rules })
  const theirs = await handle(readOnly, 'conversation.approvalRules', {})
  assert.ok(theirs.ok)
  assert.ok(!JSON.stringify(theirs.result).includes('/Users/dev'), JSON.stringify(theirs.result))
  assert.deepEqual(theirs.ok && theirs.result, {
    ok: true,
    rules: [
      {
        ...rules[0],
        workspaceRoot: 'app',
        matcher: { type: 'path', prefix: 'app' },
        label: 'Write: files within app except .git',
      },
      { ...rules[1], workspaceRoot: 'app' },
    ],
  })
})

test('what a client that is not an owner names for a chat is held to the folders Studio knows, and never a CLI’s program', async () => {
  const { owner, paired, handle, chat } = grantsRouter()
  for (const [method, params] of [
    // Asking for a folder's `/` list may run its CLI there.
    ['conversation.commands', { cli: 'claude-code', cwd: '/Users/dev/elsewhere' }],
    ['session.send', { commandId: 'c1', sessionId: 's1', message: 'read this', files: [{ path: '/etc/passwd' }] }],
    [
      'session.send',
      { commandId: 'c8', sessionId: 's1', message: 'and this', mentions: [{ path: '/etc/hosts', kind: 'file' }] },
    ],
    [
      'session.send',
      { commandId: 'c9', sessionId: 's1', message: 'and up', mentions: [{ path: '../../etc/hosts', kind: 'file' }] },
    ],
  ] as const) {
    assert.equal(code(await handle(paired, method, params)), 'not_found', method)
    assert.equal(code(await handle(owner, method, params)), 'ok', method)
  }
  assert.equal(chat.calls.sends.length, 3, 'only the owner’s sends reached the runtime')
  assert.equal(code(await handle(paired, 'conversation.commands', { cli: 'claude-code', cwd: '/Users/dev/app' })), 'ok')
  // The agent's plan file is read only inside known folders; elsewhere Studio keeps its own copy.
  const plans: Array<string | undefined> = []
  chat.planDocument = async (input) => {
    plans.push(input.planFilePath)
    return { ok: true, path: '/Users/dev/plan.md' }
  }
  const plan = (planFilePath: string) => ({
    key: { workspaceId: 'ws-1', agentId: 'agent-1' },
    plan: '# Plan',
    planFilePath,
  })
  assert.equal(code(await handle(paired, 'conversation.planDocument', plan('/Users/dev/notes.md'))), 'ok')
  assert.equal(code(await handle(paired, 'conversation.planDocument', plan('/Users/dev/app/plan.md'))), 'ok')
  assert.equal(code(await handle(owner, 'conversation.planDocument', plan('/Users/dev/notes.md'))), 'ok')
  assert.deepEqual(plans, [undefined, '/Users/dev/app/plan.md', '/Users/dev/notes.md'])
  const command = { cliRuntimes: { 'claude-code': { command: '/tmp/not-claude' } } }
  assert.equal(code(await handle(paired, 'providers.list', command)), 'owner_required')
  assert.equal(code(await handle(owner, 'providers.list', command)), 'ok')
  assert.equal(
    code(await handle(paired, 'providers.list', { cliRuntimes: { 'claude-code': { models: ['m'] } } })),
    'ok',
  )
  // A file's bytes for `files.write` are staged only under files:write.
  const file = { purpose: 'file', mediaType: 'application/octet-stream', byteLength: 4 }
  assert.equal(
    code(await handle({ ...paired, scopes: ['conversation:operate'] }, 'uploads.begin', file)),
    'scope_required',
  )
  assert.equal(code(await handle(paired, 'uploads.begin', file)), 'ok')
})

test('a revoked app is refused everything: its connection is closed, and it cannot connect again', async () => {
  const { path, auth } = await served()
  const token = pairFakeClient(auth, 'app', [...STUDIO_SCOPES])
  const app = await socketClient(path, token)
  assert.equal((await ask(app, 'l1', 'session.list')).ok, true)
  auth.revoke('app')
  const bye = await app.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  const again = await connectLineClient(path)
  again.send(hello({ token }))
  const refused = await again.next((frame) => frame.t === 'bye' || frame.t === 'welcome')
  assert.notEqual(refused.t, 'welcome')
  again.close()
})

test('a window is shown events as its IPC shows them; a client is shown them redacted', async () => {
  const { server, path, backend } = await served()
  const window = await windowClient(server)
  const owner = await socketClient(path, OWNER_TOKEN)
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  for (const [client, id] of [
    [window, 'w'],
    [owner, 'o'],
  ] as const) {
    client.send({ t: 'sub', id, topic: 'conversation.session', params: { key } })
    await client.next((frame) => frame.t === 'frame' && frame.frame.type === 'synchronized')
  }
  backend.emit('agent-1', 'usage_updated', { inputTokens: 3, cacheReadInputTokens: 5, apiKey: 'sk-live' })
  const shown = async (client: PortClient | LineClient) => {
    const frame = await client.next((candidate) => candidate.t === 'frame' && candidate.frame.type === 'event')
    return frame.t === 'frame' && frame.frame.type === 'event' ? frame.frame.event.payload : null
  }
  assert.deepEqual(await shown(window), { inputTokens: 3, cacheReadInputTokens: 5, apiKey: 'sk-live' })
  const redacted = await shown(owner)
  assert.notEqual(redacted?.apiKey, 'sk-live')
  window.close()
  owner.close()
})

test('a picture arrives in pieces and reaches the runtime whole, spent by the one send that carries it', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const bytes = Buffer.from(Array.from({ length: 700_000 }, (_, index) => index % 251))
  const begun = await ask(window, 'b1', 'uploads.begin', { mediaType: 'image/png', byteLength: bytes.length })
  assert.ok(begun.ok)
  const { uploadId, chunkBytes } = begun.result as { uploadId: string; chunkBytes: number }
  const first = bytes.subarray(0, chunkBytes).toString('base64')
  assert.equal((await ask(window, 'a1', 'uploads.append', { uploadId, offset: 0, dataBase64: first })).ok, true)
  // The same piece again (a request resent after a dropped connection) is answered, not added twice.
  const again = await ask(window, 'a2', 'uploads.append', { uploadId, offset: 0, dataBase64: first })
  assert.deepEqual(again.ok && again.result, { received: chunkBytes })
  const skipped = await ask(window, 'a3', 'uploads.append', { uploadId, offset: chunkBytes + 1, dataBase64: 'AAAA' })
  assert.equal(!skipped.ok && skipped.error.code, 'invalid_params')
  const early = await ask(window, 's0', 'session.send', {
    commandId: 'c0',
    sessionId: 's1',
    message: 'too soon',
    attachments: [{ id: 'img', uploadId }],
  })
  assert.equal(!early.ok && early.error.code, 'invalid_params', 'an unfinished picture is not sent')
  const rest = bytes.subarray(chunkBytes).toString('base64')
  assert.equal((await ask(window, 'a4', 'uploads.append', { uploadId, offset: chunkBytes, dataBase64: rest })).ok, true)
  const sent = await ask(window, 's1', 'session.send', {
    commandId: 'c1',
    sessionId: 's1',
    message: 'look',
    attachments: [{ id: 'img', uploadId, name: 'shot.png' }],
  })
  assert.ok(sent.ok)
  const carried = chat!.calls.sends[0]
  assert.equal(carried.commandId, 'owner:c1', 'a session command reaches the runtime under its namespaced id')
  assert.deepEqual(
    carried.attachments?.map(({ id, mediaType, name, byteLength }) => ({ id, mediaType, name, byteLength })),
    [{ id: 'img', mediaType: 'image/png', name: 'shot.png', byteLength: bytes.length }],
  )
  assert.equal(carried.attachments?.[0].dataBase64, bytes.toString('base64'))
  // The same send again finds its picture; another send may not take it.
  assert.ok(
    (
      await ask(window, 's2', 'session.send', {
        commandId: 'c1',
        sessionId: 's1',
        message: 'look',
        attachments: [{ id: 'img', uploadId, name: 'shot.png' }],
      })
    ).ok,
  )
  const stolen = await ask(window, 's3', 'session.send', {
    commandId: 'c2',
    sessionId: 's1',
    message: 'mine',
    attachments: [{ id: 'img', uploadId }],
  })
  assert.equal(!stolen.ok && stolen.error.code, 'invalid_params')
  window.close()
})

test('a send resent long after its pictures went is answered from its receipt, never refused for them', async () => {
  let clock = 1_000_000
  const chat = fakeChat()
  const uploads = createStudioUploads({ now: () => clock })
  disposers.push(async () => uploads.close())
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    uploads,
    now: () => clock,
  })
  const grant = studioWindowGrant()
  const context = { connectionId: 'w1', slot: 1, ownWindow: true }
  const call = (method: string, params: unknown) => router.handle(grant, method as never, params, context)
  const begun = await call('uploads.begin', { mediaType: 'image/png', byteLength: 3 })
  assert.ok(begun.ok)
  const { uploadId } = begun.result as { uploadId: string }
  assert.ok((await call('uploads.append', { uploadId, offset: 0, dataBase64: 'AAAA' })).ok)
  const send = { commandId: 'c1', sessionId: 's1', message: 'look', attachments: [{ id: 'img', uploadId }] }
  assert.ok((await call('session.send', send)).ok)
  assert.equal(chat.calls.sends[0].attachments?.length, 1)
  // Its receipt answers for it now, so the bytes are let go of at once.
  assert.equal(uploads.spend(grant.clientId, [uploadId], 'owner:c1').ok, false)
  // An hour later, after a long sleep, the window resends what it never heard answered.
  clock += 60 * 60_000
  const late = await call('session.send', send)
  assert.ok(late.ok, 'answered, not "That upload is not here"')
  assert.equal(chat.calls.sends.length, 2)
  assert.equal(chat.calls.sends[1].commandId, 'owner:c1', 'the runtime answers it from the same receipt')
  assert.equal(chat.calls.sends[1].attachments, undefined)
  router.close()
})

// A desktop driving an SSH machine's chat attaches a file from its own disk:
// the machine cannot read it by the desktop's path, so the file goes up first
// and the machine keeps it and attaches it by its own path. Never the
// desktop's path, which names nothing there.
test('a file sent up with a session’s message is kept on this machine and attached by its path here, once', async () => {
  const chat = fakeChat()
  const kept: Array<{ clientId: string; name: string; bytes: string; discarded: boolean }> = []
  const backend = createFakeBackend()
  backend.followed = {
    ...backend.followed,
    keepFile: async (clientId, file) => {
      const entry = { clientId, name: file.name, bytes: file.bytes.toString('utf8'), discarded: false }
      kept.push(entry)
      return { path: `/home/dev/.sprintengine/uploads/${kept.length}/${file.name}`, discard: () => (entry.discarded = true) }
    },
  }
  const router = createStudioRpcRouter({ backend, chat: () => chat, info: () => ({}) as never })
  disposers.push(async () => router.close())
  const grant = studioWindowGrant()
  const context = { connectionId: 'w1', slot: 1, ownWindow: true }
  const call = (method: string, params: unknown) => router.handle(grant, method as never, params, context)
  const body = Buffer.from('the notes')
  const begun = await call('uploads.begin', {
    mediaType: 'text/plain',
    byteLength: body.length,
    name: 'f1.txt',
    purpose: 'attachment',
  })
  assert.ok(begun.ok)
  const { uploadId } = begun.result as { uploadId: string }
  assert.ok((await call('uploads.append', { uploadId, offset: 0, dataBase64: body.toString('base64') })).ok)
  const send = { commandId: 'c1', sessionId: 's1', message: 'read it', fileUploadIds: [uploadId] }
  assert.ok((await call('session.send', send)).ok)
  assert.deepEqual(kept, [{ clientId: grant.clientId, name: 'f1.txt', bytes: 'the notes', discarded: false }])
  const carried = chat.calls.sends[0]!
  assert.deepEqual(carried.files, [{ path: '/home/dev/.sprintengine/uploads/1/f1.txt' }], 'attached by its path here')
  assert.equal((carried as { fileUploadIds?: unknown }).fileUploadIds, undefined)
  // The same send again is answered from its receipt, and keeps nothing more.
  assert.ok((await call('session.send', send)).ok)
  assert.equal(kept.length, 1)
  assert.equal(chat.calls.sends[1]!.files, undefined)
})

test('a Studio with nowhere to keep a file sent with a message refuses it in words', async () => {
  const chat = fakeChat()
  const router = createStudioRpcRouter({ backend: createFakeBackend(), chat: () => chat, info: () => ({}) as never })
  disposers.push(async () => router.close())
  const grant = studioWindowGrant()
  const context = { connectionId: 'w1', slot: 1, ownWindow: true }
  const call = (method: string, params: unknown) => router.handle(grant, method as never, params, context)
  const begun = await call('uploads.begin', { mediaType: 'text/plain', byteLength: 3, name: 'f.txt', purpose: 'attachment' })
  assert.ok(begun.ok)
  const { uploadId } = begun.result as { uploadId: string }
  await call('uploads.append', { uploadId, offset: 0, dataBase64: 'AAAA' })
  const refused = await call('session.send', { commandId: 'c1', sessionId: 's1', message: 'x', fileUploadIds: [uploadId] })
  assert.equal(!refused.ok && refused.error.code, 'unavailable')
  assert.equal(chat.calls.sends.length, 0)
})

test('a send with pictures resent to a session gone with its server is answered "session not found", and then from its receipt', async () => {
  const chat = fakeChat()
  const grant = studioWindowGrant()
  const context = { connectionId: 'w1', slot: 1, ownWindow: true }
  const serve = () => {
    const uploads = createStudioUploads()
    disposers.push(async () => uploads.close())
    const router = createStudioRpcRouter({
      backend: createFakeBackend(),
      chat: () => chat,
      info: () => ({}) as never,
      uploads,
    })
    disposers.push(async () => router.close())
    const call = (method: string, params: unknown) => router.handle(grant, method as never, params, context)
    const picture = async () => {
      const begun = await call('uploads.begin', { mediaType: 'image/png', byteLength: 3 })
      assert.ok(begun.ok)
      const { uploadId } = begun.result as { uploadId: string }
      assert.ok((await call('uploads.append', { uploadId, offset: 0, dataBase64: 'AAAA' })).ok)
      return uploadId
    }
    return { call, picture, uploads }
  }
  const before = serve()
  const uploadId = await before.picture()
  const send = { commandId: 'c1', sessionId: 's1', message: 'look', attachments: [{ id: 'img', uploadId }] }
  assert.ok((await before.call('session.send', send)).ok)
  // The server restarts: its uploads and the chat's session go with it.
  chat.calls.lostSessions.add('s1')
  const after = serve()
  // The window's client sends again what it never heard answered, as it was.
  const resent = await after.call('session.send', send)
  assert.ok(resent.ok, 'not refused for its pictures, which went with the server')
  assert.equal((resent.result as { code?: string }).code, CONVERSATION_SESSION_NOT_FOUND)
  // The window starts the chat again and sends once more under the same id,
  // its pictures staged again: the receipt answers it, and runs no turn.
  const restaged = await after.picture()
  const again = await after.call('session.send', {
    ...send,
    sessionId: 's2',
    attachments: [{ id: 'img', uploadId: restaged }],
  })
  assert.ok(again.ok && (again.result as { ok: boolean }).ok)
  assert.equal(chat.calls.sends.length, 2)
  assert.equal(chat.calls.sends[1].commandId, 'owner:c1')
  assert.equal(chat.calls.sends[1].attachments, undefined, 'nothing staged again for a send already made')
  assert.equal(after.uploads.size(), 0, 'the pictures staged for it are let go of')
})

test('a revert or rewind is carried out once per command id, and its answer given to every retry', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const key = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/app' }
  const params = { commandId: 'rev-1', key, turnSeq: 2, confirmed: true, files: ['a.ts'] }
  const [one, two] = await Promise.all([
    ask(window, 'r1', 'conversation.revert', params),
    ask(window, 'r2', 'conversation.revert', params),
  ])
  assert.deepEqual(one.ok && one.result, two.ok && two.result)
  assert.equal(chat!.calls.reverts, 1)
  await ask(window, 'r3', 'conversation.revert', { ...params, commandId: 'rev-2' })
  assert.equal(chat!.calls.reverts, 2)
  window.close()
})

test('the command list is pushed to an owner as each is reported, and its stream ends with the connection', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  window.send({ t: 'sub', id: 'cmds', topic: 'conversation.commands' })
  for (let tries = 0; chat!.calls.commandListeners.size === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.commandListeners.size, 1)
  const catalog = {
    cli: 'codex',
    cwd: '/Users/dev/app',
    commands: [{ name: 'review', source: 'cli' as const }],
    fetchedAt: 2,
  }
  for (const listener of chat!.calls.commandListeners) listener(catalog)
  const push = await window.next(isT('push'))
  assert.deepEqual(push.t === 'push' && push.payload, catalog)
  window.close()
  await window.closed
  for (let tries = 0; chat!.calls.commandListeners.size > 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.commandListeners.size, 0)
})

test('a window is answered as its IPC was, never busy: a transcript checks every link it shows at once', async () => {
  const stat = { isFile: true, isDirectory: false, sizeBytes: 1, modifiedAt: '', modifiedAtMs: 1 }
  const fileSystem = {
    ...createStudioFileSystem({ readableRoots: () => [], writableRoots: () => [] }),
    stat: async () => stat,
  }
  const started = await startTestServer({ chat: fakeChat(), fileSystem })
  disposers.push(started.dispose)
  const window = await windowClient(started.server)
  const answers = await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      ask(window, `stat-${index}`, 'files.stat', { path: `/Users/dev/app/${index}.ts` }),
    ),
  )
  assert.deepEqual(
    answers.filter((answer) => !answer.ok).map((answer) => !answer.ok && answer.error.code),
    [],
  )
  window.close()
})

test('a stream Studio cannot read is told to a client in stable words with an id, and to a window as its IPC says it', async () => {
  const { server, path, backend, logs } = await served()
  backend.follow = (_key, _cursor, listener) => {
    queueMicrotask(() =>
      listener({ type: 'error', message: 'EACCES: /Users/dev/app/.sprintengine/conversations/a.jsonl' }),
    )
    return { dispose: () => undefined, ready: Promise.resolve() }
  }
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const owner = await socketClient(path, OWNER_TOKEN)
  owner.send({ t: 'sub', id: 'o', topic: 'conversation.session', params: { key } })
  const told = await owner.next(isT('subFailed'))
  assert.ok(told.t === 'subFailed')
  assert.equal(told.message, 'Studio could not read this conversation just now.')
  assert.equal(told.retryable, true)
  assert.ok(logs.some((line) => line.includes(`[${told.errorId}]`) && line.includes('EACCES')))
  const window = await windowClient(server)
  window.send({ t: 'sub', id: 'w', topic: 'conversation.session', params: { key } })
  const shown = await window.next(isT('subFailed'))
  assert.equal(shown.t === 'subFailed' && shown.message, 'EACCES: /Users/dev/app/.sprintengine/conversations/a.jsonl')
  owner.close()
  window.close()
})

test('an owner’s web tab is Studio’s own view, and its mutations are audited all the same', async () => {
  const chat = fakeChat()
  const audited: string[] = []
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    audit: (entry) => void audited.push(entry.tool),
  })
  const grant = studioWindowGrant()
  const send = { commandId: 'c1', sessionId: 's1', message: 'hello' }
  await router.handle(grant, 'session.send', send, { connectionId: 'w1', slot: 1, ownWindow: true })
  assert.deepEqual(audited, [], 'a desktop window is the app, and is not audited')
  await router.handle(
    grant,
    'session.send',
    { ...send, commandId: 'c2' },
    {
      connectionId: 'w2',
      slot: 2,
      ownWindow: true,
      audited: true,
    },
  )
  assert.deepEqual(audited, ['session.send'])
  router.close()
})

test('every operation a window’s chat makes is a method an owner calls on the socket', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const answers = {
    list: await ask(window, 'a1', 'session.list', { workspaceId: 'ws-1' }),
    stop: await ask(window, 'a2', 'session.stop', { commandId: 'c-stop', sessionId: 's1' }),
    suspend: await ask(window, 'a3', 'session.suspend', { commandId: 'c-suspend', sessionId: 's1' }),
    mcp: await ask(window, 'a4', 'session.mcpServerAction', {
      commandId: 'c-mcp',
      sessionId: 's1',
      serverId: 'github',
      action: 'reconnect',
    }),
    stopSubagent: await ask(window, 'a5', 'session.stopSubagent', {
      commandId: 'c-ss',
      sessionId: 's1',
      toolUseId: 'task-1',
    }),
    messageSubagent: await ask(window, 'a6', 'session.messageSubagent', {
      commandId: 'c-ms',
      sessionId: 's1',
      toolUseId: 'task-1',
      message: 'Look at the tests too.',
    }),
    side: await ask(window, 'a7', 'session.askSideQuestion', {
      commandId: 'c-side',
      sessionId: 's1',
      requestId: 'q1',
      question: 'Why?',
      history: [{ question: 'What?', answer: 'This.' }],
    }),
    cancelSide: await ask(window, 'a8', 'session.cancelSideQuestion', { sessionId: 's1', requestId: 'q1' }),
    context: await ask(window, 'a9', 'session.contextBreakdown', { sessionId: 's1' }),
    handoff: await ask(window, 'a10', 'session.terminalHandoff', { commandId: 'c-th', sessionId: 's1' }),
    threads: await ask(window, 'a11', 'conversation.threads', { workspaceId: 'ws-1', workspaceRoot: '/Users/dev/app' }),
    search: await ask(window, 'a12', 'conversation.search', {
      workspaceId: 'ws-1',
      workspaceRoot: '/Users/dev/app',
      query: 'flaky',
      requestId: 's-1',
    }),
    cancelSearch: await ask(window, 'a13', 'conversation.cancelSearch', { requestId: 's-1' }),
    rules: await ask(window, 'a14', 'conversation.approvalRules'),
    revoke: await ask(window, 'a15', 'conversation.revokeApprovalRule', { commandId: 'c-rv', ruleId: 'rule-1' }),
    signIn: await ask(window, 'a16', 'providers.signIn', { providerId: 'claude-code' }),
    setSecret: await ask(window, 'a17', 'providers.setSecret', {
      commandId: 'c-set',
      providerId: 'openai-compatible',
      value: 'sk-test',
    }),
    clearSecret: await ask(window, 'a18', 'providers.clearSecret', {
      commandId: 'c-clear',
      providerId: 'openai-compatible',
    }),
  }
  for (const [name, answer] of Object.entries(answers)) assert.equal(answer.ok, true, name)
  assert.deepEqual(answers.search.ok && answers.search.result, {
    ok: true,
    hits: [{ agentId: 'agent-1', seq: 3, snippet: 'flaky' }],
  })
  assert.deepEqual(chat!.calls.controls, [
    'stop:s1:owner:c-stop',
    'suspend:s1',
    'mcp:github:reconnect',
    'stop-subagent:task-1',
    'message-subagent:task-1:Look at the tests too.',
    'side-question:q1:1',
    'cancel-side-question:q1',
    'terminal-handoff:s1',
    'threads:/Users/dev/app',
    'search:/Users/dev/app:flaky',
    'cancel-search:s-1',
    'revoke:rule-1',
    'set-secret:openai-compatible',
    'clear-secret:openai-compatible',
  ])
  // A control the runtime keeps no receipt for is carried out once per command id.
  const again = await ask(window, 'b1', 'session.suspend', { commandId: 'c-suspend', sessionId: 's1' })
  assert.deepEqual(again.ok && again.result, answers.suspend.ok && answers.suspend.result)
  assert.equal(chat!.calls.controls.filter((call) => call === 'suspend:s1').length, 1)
  window.close()
  await window.closed
  for (let tries = 0; chat!.calls.releasedHistory.length === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.releasedHistory.length, 1, 'a closed connection’s history searches are ended')
})

test('a malformed control is refused at the edge, before the chat surface sees it', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  const refusals = [
    await ask(window, 'm1', 'session.mcpServerAction', {
      commandId: 'c',
      sessionId: 's1',
      serverId: 'x',
      action: 'wipe',
    }),
    await ask(window, 'm2', 'session.messageSubagent', {
      commandId: 'c',
      sessionId: 's1',
      toolUseId: 't',
      message: ' ',
    }),
    await ask(window, 'm3', 'session.askSideQuestion', {
      commandId: 'c',
      sessionId: 's1',
      requestId: 'q',
      question: 'Why?',
      history: Array.from({ length: 21 }, () => ({ question: 'a', answer: 'b' })),
    }),
    await ask(window, 'm4', 'session.terminalHandoff', { commandId: 'c' }),
    await ask(window, 'm5', 'conversation.search', { workspaceId: 'ws-1', query: '' }),
    await ask(window, 'm6', 'providers.setSecret', { commandId: 'c', providerId: 'p', value: '' }),
  ]
  for (const refusal of refusals) assert.equal(!refusal.ok && refusal.error.code, 'invalid_params')
  assert.deepEqual(chat!.calls.controls, [])
  window.close()
})

test('every chat’s lifecycle is pushed to an owner as it happens, and its stream ends with the connection', async () => {
  const { server, chat } = await served()
  const window = await windowClient(server)
  window.send({ t: 'sub', id: 'life', topic: 'conversation.events' })
  for (let tries = 0; chat!.calls.lifecycleListeners.size === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const event = {
    id: 'e1',
    seq: 4,
    sessionId: 's1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    type: 'turn_completed',
    createdAt: 5,
  } as unknown as ConversationEvent
  for (const listener of chat!.calls.lifecycleListeners) listener(event)
  const push = await window.next(isT('push'))
  assert.deepEqual(push.t === 'push' && push.payload, event)
  window.close()
  await window.closed
  for (let tries = 0; chat!.calls.lifecycleListeners.size > 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(chat!.calls.lifecycleListeners.size, 0)
})

test('terminal handoff is advertised only where the chat surface opens terminals', async () => {
  const { terminalHandoff: _handoff, ...withoutTerminals } = fakeChat()
  const served_ = await served({ chat: withoutTerminals as ReturnType<typeof fakeChat> })
  const owner = await connectLineClient(served_.path)
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next(isT('welcome'))
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('session-terminal-handoff'), false)
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('session-controls'), true)
  const refused = await ask(owner, 'h1', 'session.terminalHandoff', { commandId: 'c', sessionId: 's1' })
  assert.equal(!refused.ok && refused.error.code, 'unavailable')
  owner.close()
})

/** A chat backend that reads an export of `count` events, each about `size` characters, and one picture. */
function exportingChat(count: number, size = 10) {
  const chat = fakeChat()
  const reads: Array<{ workspaceId: string; agentId: string }> = []
  chat.exportSource = async (key) => {
    reads.push(key)
    if (key.agentId !== 'agent-1') return { ok: false, code: 'not_found', message: 'This chat could not be found.' }
    return {
      ok: true,
      chat: { title: 'Atlas', project: 'app', providerId: 'mock', modelId: 'mock', workspaceRoot: '/Users/dev/app' },
      events: Array.from({ length: count }, (_, index) => ({
        id: `e${index}`,
        seq: index + 1,
        type: 'assistant_message',
        sessionId: 's1',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        providerId: 'mock',
        modelId: 'mock',
        createdAt: index,
        payload: { text: 'x'.repeat(size), authorization: 'Bearer abc' },
      })) as never,
      attachments: { 'attachments/a.png': { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' } },
    }
  }
  return { chat, reads }
}

test('a chat’s export is read once where it is kept and paged to the client, pictures after the events', async () => {
  const { chat, reads } = exportingChat(5, 1024 * 1024)
  const { server, path, auth } = await served({ chat })
  const window = await windowClient(server)
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const events: number[] = []
  let pictures: string[] = []
  let offset: number | null = 0
  for (let page = 0; offset !== null; page++) {
    const answer = await ask(window, `x${page}`, 'conversation.exportPage', { key, exportId: 'export-1', offset })
    assert.ok(answer.ok, JSON.stringify(answer))
    const result = answer.result as {
      chat: { title: string }
      events: Array<{ seq: number }>
      attachments: Record<string, unknown>
      nextOffset: number | null
    }
    assert.equal(result.chat.title, 'Atlas')
    events.push(...result.events.map((event) => event.seq))
    pictures = [...pictures, ...Object.keys(result.attachments)]
    offset = result.nextOffset
  }
  // A megabyte an event: several pages, each event once and in order, the picture last.
  assert.deepEqual(events, [1, 2, 3, 4, 5])
  assert.deepEqual(pictures, ['attachments/a.png'])
  assert.equal(reads.length, 1, 'the transcript was read once, for the first page')
  // The last page let it go: a later page is refused, and starting again reads again.
  const late = await ask(window, 'late', 'conversation.exportPage', { key, exportId: 'export-1', offset: 3 })
  assert.equal(!late.ok && late.error.code, 'not_found')

  // A paired client that follows chats reads one too, redacted as everything it reads.
  const reader = await socketClient(path, pairFakeClient(auth, 'reader', ['conversation:read']))
  const first = await ask(reader, 'r1', 'conversation.exportPage', { key, exportId: 'mine', offset: 0 })
  assert.ok(first.ok)
  assert.ok(!JSON.stringify(first.result).includes('Bearer abc'), 'a secret-shaped member is redacted')
  // Another client's held export is not this one's.
  const theirs = await ask(reader, 'r2', 'conversation.exportPage', { key, exportId: 'export-2', offset: 1 })
  assert.equal(!theirs.ok && theirs.error.code, 'not_found')
  // A client that follows no chats reads none.
  const stranger = await socketClient(path, pairFakeClient(auth, 'stranger', ['workspaces:read']))
  const refused = await ask(stranger, 's1', 'conversation.exportPage', { key, exportId: 'x', offset: 0 })
  assert.equal(!refused.ok && refused.error.code, 'scope_required')
  // A chat that is not a conversation here is not found.
  const missing = await ask(window, 'm', 'conversation.exportPage', {
    key: { workspaceId: 'ws-1', agentId: 'nobody' },
    exportId: 'export-3',
    offset: 0,
  })
  assert.equal(!missing.ok && missing.error.code, 'not_found')
})

test('a held export outlives its connection only for the reconnect that asks for its next page again', async () => {
  let clock = 1_000_000
  const { chat, reads } = exportingChat(12, 1024 * 1024)
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    chat: () => chat,
    info: () => ({}) as never,
    now: () => clock,
  })
  disposers.push(async () => router.close())
  // A client sends again on its new connection what was unanswered; a minute is the wait.
  const heldAfterClose = 60_000
  const grant = {
    clientId: 'reader',
    name: 'reader',
    owner: false,
    scopes: ['conversation:read'],
    ceiling: 'auto',
  } as never
  const key = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const page = async (connectionId: string, exportId: string, offset: number) => {
    const answer = await router.handle(
      grant,
      'conversation.exportPage',
      { key, exportId, offset },
      {
        connectionId,
        slot: 1,
        ownWindow: false,
      },
    )
    return answer.ok ? (answer.result as { nextOffset: number | null }).nextOffset : answer.error.code
  }
  // Each connection part way through an export of its own.
  const resumed = await page('c1', 'resumed', 0)
  const kept = await page('c2', 'kept', 0)
  assert.ok(typeof resumed === 'number' && typeof kept === 'number', 'each has pages left')
  // c1 drops; the client's reconnect asks for the same page again, which is still held.
  router.connectionClosed('c1')
  clock += heldAfterClose - 1
  const before = reads.length
  assert.equal(typeof (await page('c3', 'resumed', resumed)), 'number')
  assert.equal(reads.length, before, 'the chat is not read again')
  // c3 drops and nobody comes back: past the wait, its export is let go of.
  router.connectionClosed('c3')
  clock += heldAfterClose
  assert.equal(await page('c4', 'resumed', resumed), 'not_found')
  // c2 is still open, so its export is held as long as before.
  assert.equal(typeof (await page('c2', 'kept', kept)), 'number')
  assert.equal(reads.length, before)
})

test('a Studio says it serves exports only where its chat surface reads them', async () => {
  const unread = fakeChat()
  delete unread.exportSource
  const plain = await served({ chat: unread })
  const reading = await served({ chat: exportingChat(1).chat })
  for (const [started, serves] of [
    [plain, false],
    [reading, true],
  ] as const) {
    const window = await windowClient(started.server)
    const info = await ask(window, 'i', 'server.info')
    assert.equal(
      ((info.ok && (info.result as { capabilities: string[] }).capabilities) || []).includes('conversation-export'),
      serves,
    )
    const answer = await ask(window, 'x', 'conversation.exportPage', {
      key: { workspaceId: 'ws-1', agentId: 'agent-1' },
      exportId: 'e',
      offset: 0,
    })
    assert.equal(answer.ok, serves)
  }
})
