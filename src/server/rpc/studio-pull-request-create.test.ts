import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/public'
import {
  createConversationPullRequests,
  type ConversationPullRequestToolsDeps,
} from '../../main/automation/conversation-pull-request-tools'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// A chat's Create PR over the Studio protocol (`pull-request-create`): every
// step asked of the Studio that holds the chat, in the chat's own checkout
// there, through the same steps the gateway's tools run for a paired
// desktop. Each is an owner's: a paired app holding every scope is refused.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const PIN = { branch: 'feature/marks', headSha: 'abc1234def' }

function fakeCreation(options: { engine?: boolean; recorded?: boolean } = {}) {
  const calls: string[] = []
  const deps: ConversationPullRequestToolsDeps = {
    checkoutOf: (key) => {
      if (key.workspaceId !== 'ws-1') return { ok: false, code: 'unknown_workspace', message: 'Not known here.' }
      if (key.agentId === 'on-ssh')
        return { ok: false, code: 'checkout_elsewhere', message: "That chat's checkout is on another machine." }
      return { ok: true, root: '/Users/dev/app' }
    },
    creator: {
      state: async (cwd) => {
        calls.push(`state:${cwd}`)
        return {
          readiness: { ready: true },
          gitRoot: cwd,
          branch: PIN.branch,
          headSha: PIN.headSha,
          uncommittedChanges: 0,
          base: 'main',
          forge: 'github',
        }
      },
      draftInput: async () => ({ ok: true, input: { branch: PIN.branch } as never }),
      push: async (cwd, pin) => {
        calls.push(`push:${cwd}:${pin?.headSha ?? 'none'}`)
        return { ok: true, pushed: true }
      },
      create: async (cwd, text) => {
        calls.push(`create:${cwd}:${text.title}`)
        return { ok: true, kind: 'created', url: 'https://github.com/acme/app/pull/40' }
      },
    },
    draftEngine: () =>
      options.engine === false ? null : { engine: { cli: 'claude-code', model: '' }, writingStyle: 'repository' as never },
    generate: async () => ({ ok: true, value: { title: 'feat: marks', body: 'Body' }, ms: 1 }),
    link: async (input) => {
      calls.push(`link:${input.conversation.agentId}:${input.url}`)
      return options.recorded === false ? { ok: false, message: 'The record is busy.' } : { ok: true }
    },
  }
  return { creation: createConversationPullRequests(deps), calls }
}

async function serve(creation?: ReturnType<typeof fakeCreation>['creation']) {
  const started = await startTestServer(creation ? { pullRequestCreation: creation } : {})
  cleanups.push(() => started.dispose())
  return started
}

async function client(path: string, token: string) {
  const c = await connectLineClient(path)
  cleanups.push(() => c.close())
  c.send(hello({ token }))
  const welcome = await c.next((frame) => frame.t === 'welcome')
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = `r${++seq}`
    c.send({ t: 'req', id, method, params })
    const answer = await c.next((frame) => frame.t === 'res' && frame.id === id)
    if (answer.t !== 'res') throw new Error('not a response')
    return answer
  }
  return { welcome, request }
}

test('an owner reads, drafts, pushes and creates in the chat’s checkout on its Studio, and the creation is recorded', async () => {
  const { creation, calls } = fakeCreation()
  const started = await serve(creation)
  const owner = await client(started.path, OWNER_TOKEN)
  assert.ok(owner.welcome.t === 'welcome' && owner.welcome.capabilities.includes('pull-request-create'))

  const state = await owner.request('pullRequests.createState', { conversation: CHAT })
  assert.ok(state.ok)
  // No path on the Studio's disk crosses the wire.
  assert.deepEqual((state.result as { state: { gitRoot: unknown; branch: string } }).state.gitRoot, null)
  assert.equal((state.result as { state: { branch: string } }).state.branch, PIN.branch)

  const draft = await owner.request('pullRequests.draft', { conversation: CHAT, draftId: 'd1' })
  assert.deepEqual(draft.ok && draft.result, { ok: true, title: 'feat: marks', body: 'Body' })

  const push = { conversation: CHAT, commandId: 'push-1', pin: PIN }
  const [one, two] = await Promise.all([
    owner.request('pullRequests.push', push),
    owner.request('pullRequests.push', push),
  ])
  assert.deepEqual(one.ok && one.result, { ok: true, pushed: true })
  assert.deepEqual(two.ok && two.result, { ok: true, pushed: true })

  const created = await owner.request('pullRequests.create', {
    conversation: CHAT,
    commandId: 'create-1',
    title: '  feat: marks ',
    body: 'Body',
    pin: PIN,
  })
  assert.deepEqual(created.ok && created.result, {
    ok: true,
    kind: 'created',
    url: 'https://github.com/acme/app/pull/40',
    recorded: true,
  })
  // A retry of the same creation is answered from the first, never opened twice.
  const again = await owner.request('pullRequests.create', {
    conversation: CHAT,
    commandId: 'create-1',
    title: 'feat: marks',
    body: 'Body',
    pin: PIN,
  })
  assert.ok(again.ok)
  assert.deepEqual(calls, [
    'state:/Users/dev/app',
    'push:/Users/dev/app:abc1234def',
    'create:/Users/dev/app:feat: marks',
    'link:agent-1:https://github.com/acme/app/pull/40',
  ])
})

test('a paired app holding every scope is refused every step: they are an owner’s', async () => {
  const { creation, calls } = fakeCreation()
  const started = await serve(creation)
  const paired = await client(started.path, pairFakeClient(started.auth, 'tablet', [...STUDIO_SCOPES]))
  for (const [method, params] of [
    ['pullRequests.createState', { conversation: CHAT }],
    ['pullRequests.draft', { conversation: CHAT, draftId: 'd1' }],
    ['pullRequests.draftCancel', { conversation: CHAT, draftId: 'd1' }],
    ['pullRequests.push', { conversation: CHAT, commandId: 'p1' }],
    ['pullRequests.create', { conversation: CHAT, commandId: 'c1', title: 't', body: 'b' }],
  ] as const) {
    const answer = await paired.request(method, params)
    assert.equal(!answer.ok && answer.error.code, 'owner_required', method)
  }
  assert.deepEqual(calls, [])
})

test('a chat not here is not found; one whose checkout is elsewhere has no state, and its steps say why', async () => {
  const { creation } = fakeCreation()
  const started = await serve(creation)
  const owner = await client(started.path, OWNER_TOKEN)
  const missing = await owner.request('pullRequests.createState', { conversation: { workspaceId: 'w9', agentId: 'a' } })
  assert.equal(!missing.ok && missing.error.code, 'not_found')
  const elsewhere = { workspaceId: 'ws-1', agentId: 'on-ssh' }
  const state = await owner.request('pullRequests.createState', { conversation: elsewhere })
  assert.deepEqual(state.ok && state.result, { state: null })
  const push = await owner.request('pullRequests.push', { conversation: elsewhere, commandId: 'p1' })
  // In stable words to a client on the socket; Studio's own window hears the core's.
  assert.equal(!push.ok && push.error.code, 'unavailable')
})

test('text generation off is said as it is, and a creation not recorded says so with its address', async () => {
  const { creation } = fakeCreation({ engine: false, recorded: false })
  const started = await serve(creation)
  const owner = await client(started.path, OWNER_TOKEN)
  const draft = await owner.request('pullRequests.draft', { conversation: CHAT, draftId: 'd1' })
  assert.equal(draft.ok && (draft.result as { code: string }).code, 'text_generation_off')
  const created = await owner.request('pullRequests.create', {
    conversation: CHAT,
    commandId: 'c1',
    title: 'feat: marks',
    body: 'Body',
  })
  const result = created.ok ? (created.result as { recorded: boolean; recordMessage: string }) : null
  assert.equal(result?.recorded, false)
  assert.match(result?.recordMessage ?? '', /pull\/40/u)
})

test('a Studio without Create PR does not advertise it, and answers its steps unavailable', async () => {
  const started = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  assert.ok(owner.welcome.t === 'welcome' && !owner.welcome.capabilities.includes('pull-request-create'))
  const answer = await owner.request('pullRequests.createState', { conversation: CHAT })
  assert.equal(!answer.ok && answer.error.code, 'unavailable')
})
