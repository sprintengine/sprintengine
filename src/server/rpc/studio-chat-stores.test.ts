import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import {
  STUDIO_CHAT_STORES_METHODS,
  STUDIO_METHOD_ACCESS,
  type StudioChatStoresMethod,
  type StudioScope,
  type UsageLimitResumeState,
  type UsageLimitResumeUpdate,
  type UsageLimitsState,
} from '../../../packages/studio-protocol/src/public'
import type { StudioChatStores } from '../chat-stores/chat-stores-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `usageLimits.*`, `usageLimitResumes.*`, `usage.report` and `conversationImport.*` over the owner socket, under every
// kind of grant: an owner's, a pairing given the scopes, one that may only
// read chats, and one revoked. The stores behind them are stubs; what they
// decide is their own tests'.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function stubs() {
  const asked: Array<[string, unknown]> = []
  const limits = new Set<(state: UsageLimitsState) => void>()
  const resumes = new Set<(state: UsageLimitResumeState) => void>()
  const listen =
    <T>(set: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      set.add(listener)
      return () => void set.delete(listener)
    }
  const resumeState: UsageLimitResumeState = { autoResume: false, notices: [] }
  const stores: StudioChatStores = {
    usageLimits: async () => ({ snapshots: [] }),
    onUsageLimitsChanged: listen(limits),
    usageLimitResumes: () => resumeState,
    updateUsageLimitResume: (update: UsageLimitResumeUpdate) => {
      asked.push(['resume', update])
      return resumeState
    },
    onUsageLimitResumesChanged: listen(resumes),
    usageReport: async (request) => {
      asked.push(['report', request])
      return { ok: false, message: 'no logs' }
    },
    usageRows: async (args) => {
      asked.push(['rows', args])
      return {
        ok: true,
        version: 1,
        scannedAt: null,
        scanning: false,
        sources: [],
        sessions: [],
        rows: [],
        nextFrom: null,
      }
    },
    scanImports: async () => ({ ok: true, folders: [], sources: [] }),
    importConversations: async (input) => {
      asked.push(['import', input])
      return { ok: true, imported: [], skipped: 0, failed: [] }
    },
    dispose: async () => undefined,
  }
  const emit = {
    limits: (state: UsageLimitsState) => limits.forEach((listener) => listener(state)),
    resumes: (state: UsageLimitResumeState) => resumes.forEach((listener) => listener(state)),
  }
  return { stores, asked, emit }
}

async function serve(withStores = true) {
  const domain = stubs()
  const started = await startTestServer(withStores ? { chatStores: domain.stores } : {})
  cleanups.push(() => started.dispose())
  return { started, ...domain }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown = {}) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null
const resultOf = (frame: { t: string; ok?: boolean; result?: unknown }) =>
  frame.t === 'res' && frame.ok ? frame.result : undefined

/** Each method with params its validator takes. */
const CALLS: Record<StudioChatStoresMethod, Record<string, unknown>> = {
  'usageLimits.get': {},
  'usageLimitResumes.get': {},
  'usageLimitResumes.update': { commandId: 'c-resume', workspaceId: 'w', agentId: 'a', action: 'schedule' },
  'usageLimitResumes.setAuto': { commandId: 'c-auto', enabled: true },
  'usage.report': { from: 1, to: 2 },
  'usage.rows': { from: 1, to: 2 },
  'conversationImport.scan': {},
  'conversationImport.import': { commandId: 'c-import', sessions: [{ source: 'codex', sessionId: 's1' }] },
}

test('every method of the family has a call here', () => {
  assert.deepEqual(Object.keys(CALLS).sort(), Object.keys(STUDIO_CHAT_STORES_METHODS).sort())
})

test('a Studio with the stores advertises them; one without refuses every call and stream', async () => {
  const served = await serve()
  const owner = await client(served.started.path, OWNER_TOKEN)
  assert.ok(owner.welcome.t === 'welcome' && owner.welcome.capabilities.includes('chat-stores'))
  const bare = await serve(false)
  const other = await client(bare.started.path, OWNER_TOKEN)
  assert.equal(other.welcome.t === 'welcome' && other.welcome.capabilities.includes('chat-stores'), false)
  assert.equal(codeOf(await other.request('usageLimitResumes.get', {})), 'unavailable')
  const refused = await other.subscribe('usageLimitResumes.changed')
  const failed = await other.line.next((frame) => frame.t === 'subFailed' && frame.sub === refused)
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test('an owner reaches every method, and a change is carried out once per command id', async () => {
  const { started, asked } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(CALLS))
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, null])
  // The same command again (a retry after a dropped connection) is answered, not done twice.
  await owner.request('usageLimitResumes.update', CALLS['usageLimitResumes.update'])
  await owner.request('usageLimitResumes.setAuto', CALLS['usageLimitResumes.setAuto'])
  assert.deepEqual(
    asked.filter(([kind]) => kind === 'resume'),
    [
      ['resume', { kind: 'schedule', workspaceId: 'w', agentId: 'a' }],
      ['resume', { kind: 'auto', enabled: true }],
    ],
  )
  assert.deepEqual(resultOf(await owner.request('usage.report', { from: 1, to: 2 })), { ok: false, message: 'no logs' })
})

test('an owner follows every stream, each push the store’s state whole', async () => {
  const { started, emit } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const limits = await owner.subscribe('usageLimits.changed')
  const resumes = await owner.subscribe('usageLimitResumes.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  emit.limits({ snapshots: [] })
  await owner.line.next((frame) => frame.t === 'push' && frame.sub === limits)
  emit.resumes({ autoResume: true, notices: [] })
  const resumed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === resumes)
  assert.deepEqual(resumed.t === 'push' && resumed.payload, { autoResume: true, notices: [] })
})

test('a paired app reaches what its scopes name, never the report or the import; a reader only reads', async () => {
  const { started, asked } = await serve()
  const scopes: StudioScope[] = [
    'providers:read',
    'settings:write',
    'conversation:read',
    'conversation:operate',
    'conversation:create',
    // A paired desktop's dashboard reads this machine's rows on its workspace read.
    'workspaces:read',
  ]
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  for (const [method, params] of Object.entries(CALLS)) {
    const access = STUDIO_METHOD_ACCESS[method as StudioChatStoresMethod]
    const expected = 'permissions' in access && access.owner !== undefined ? 'owner_required' : null
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, expected])
  }
  assert.equal(
    asked.some(([kind]) => kind === 'report' || kind === 'import'),
    false,
  )

  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['conversation:read']))
  assert.equal(codeOf(await reader.request('usageLimitResumes.get', {})), null)
  for (const method of ['usageLimitResumes.update', 'usageLimitResumes.setAuto'] as const)
    assert.notEqual(codeOf(await reader.request(method, { ...CALLS[method], commandId: `r-${method}` })), null, method)
  assert.notEqual(codeOf(await reader.request('usageLimits.get', {})), null, 'the limits are the plan’s')
  assert.equal(
    codeOf(await reader.request('usage.rows', CALLS['usage.rows'])),
    'scope_required',
    'the rows are a workspace read',
  )
})

test('a revoked app is ended at its next frame, and hears nothing after', async () => {
  const { started, emit } = await serve()
  const app = await client(started.path, pairFakeClient(started.auth, 'app', ['conversation:read']))
  assert.ok(resultOf(await app.request('usageLimitResumes.get', {})))
  await app.subscribe('usageLimitResumes.changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  started.auth.grants.delete('app')
  emit.resumes({
    autoResume: false,
    notices: [{ workspaceId: 'w', agentId: 'a', text: 'after the revoke' } as never],
  })
  const bye = await app.line.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  assert.equal(
    app.line.frames.some((frame) => frame.t === 'push' && JSON.stringify(frame).includes('after the revoke')),
    false,
  )
})
