import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioClient, StudioClientState } from '../../../../packages/client-runtime/src/public'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { withEnvironmentSessions } from '../hooks/conversationSessionsStore'
import {
  createEnvironmentChatSource,
  followEnvironmentChats,
  followedEnvironmentChats,
  type EnvironmentChatSource,
} from './environmentChats'
import type { EnvironmentHold } from './environmentStudio'

const session = (workspaceId: string, sessionId = `s-${workspaceId}`): ConversationSessionSummary => ({
  sessionId,
  workspaceId,
  agentId: 'agent-1',
  providerId: 'fake',
  modelId: 'fake-model',
  status: 'ready',
  createdAt: 1,
  updatedAt: 1,
})

/** One environment's Studio as the window's client reaches it, and the hold that keeps it open. */
function fakeEnvironment(environmentId: string, listed: ConversationSessionSummary[]) {
  const states = new Set<(state: StudioClientState) => void>()
  const pushes = new Set<(payload: unknown) => void>()
  let lists = 0
  let released = 0
  const client = {
    state: 'open' as StudioClientState,
    welcome: { environment: { id: environmentId } },
    supports: () => true,
    request: async (method: string) => {
      assert.equal(method, 'session.list')
      lists += 1
      return { ok: true, sessions: listed }
    },
    subscribe: (_topic: string, _params: unknown, listener: { onPayload(payload: unknown): void }) => {
      pushes.add(listener.onPayload)
      return () => pushes.delete(listener.onPayload)
    },
    closed: new Promise<void>(() => undefined),
  }
  const hold: EnvironmentHold = {
    client: Promise.resolve(client as unknown as StudioClient),
    onState(listener) {
      states.add(listener)
      return () => states.delete(listener)
    },
    release: () => {
      released += 1
    },
  }
  return {
    hold,
    listed,
    lists: () => lists,
    released: () => released,
    push: (event: unknown) => {
      for (const listener of [...pushes]) listener(event)
    },
    move: (state: StudioClientState) => {
      client.state = state
      for (const listener of [...states]) listener(state)
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => followEnvironmentChats([]))

test("an environment's chats are listed by address, and read again when a session moves there", async () => {
  const machine = fakeEnvironment('env-box', [session('w-1')])
  const source = createEnvironmentChatSource(
    { route: 'ssh:box', name: 'build-box' },
    { hold: () => machine.hold, settleMs: 1 },
  )
  const heard: number[] = []
  source.subscribe(() => heard.push(source.snapshot().sessions.length))
  await settle()
  const first = source.snapshot()
  assert.equal(first.environmentId, 'env-box')
  assert.equal(first.stale, false)
  assert.deepEqual([...first.byAddress.keys()], ['env-box:w-1'])

  machine.listed.push(session('w-2'))
  machine.push({ type: 'session_started', sessionId: 's-w-2', workspaceId: 'w-2', agentId: 'agent-1' })
  await settle()
  assert.deepEqual([...source.snapshot().byAddress.keys()].sort(), ['env-box:w-1', 'env-box:w-2'])
  assert.ok(machine.lists() >= 2)
  source.close()
  assert.equal(machine.released(), 1)
})

test('while the machine is away its last list stays, said to be stale, and is read again once it is back', async () => {
  const machine = fakeEnvironment('env-box', [session('w-1')])
  const source = createEnvironmentChatSource(
    { route: 'ssh:box', name: 'build-box' },
    { hold: () => machine.hold, settleMs: 1 },
  )
  source.subscribe(() => undefined)
  await settle()
  const before = machine.lists()
  machine.move('reconnecting')
  assert.equal(source.snapshot().stale, true)
  assert.equal(source.snapshot().sessions.length, 1, 'the rows stay where they are')
  machine.move('open')
  await settle()
  assert.equal(source.snapshot().stale, false)
  assert.ok(machine.lists() > before, 'read again on the reconnect')
  source.close()
})

test("the window's one session list joins every followed environment's to its own, and hears their changes", async () => {
  const machine = fakeEnvironment('env-box', [session('w-ssh')])
  followEnvironmentChats([{ route: 'ssh:box', name: 'build-box' }], (target) =>
    createEnvironmentChatSource(target, { hold: () => machine.hold, settleMs: 1 }),
  )
  await settle()
  const local = {
    list: async () => ({ ok: true as const, sessions: [session('w-here')] }),
    onLifecycleEvent: () => () => undefined,
  }
  // The window holds the SSH machine's chat's record, under that route.
  const merged = withEnvironmentSessions(
    local,
    (route, workspaceId) => route === 'ssh:box' && workspaceId.startsWith('w-ssh'),
  )
  let changes = 0
  const stop = merged.onLifecycleEvent!(
    () => undefined,
    () => (changes += 1),
  )
  const listed = await merged.list!()
  assert.ok(listed.ok)
  assert.deepEqual(listed.sessions.map((entry) => entry.workspaceId).sort(), ['w-here', 'w-ssh'])

  machine.listed.push(session('w-ssh-2'))
  machine.push({ type: 'turn_started', sessionId: 's-w-ssh-2', workspaceId: 'w-ssh-2', agentId: 'agent-1' })
  await settle()
  assert.ok(changes > 0, 'a new list from the machine is a change to the window')
  stop()

  followEnvironmentChats([])
  assert.deepEqual(followedEnvironmentChats(), [])
  assert.equal(machine.released(), 1, 'a route no longer followed lets its connection go')
})

test("a paired desktop's sessions, under its own workspace ids, never join the window's list", async () => {
  // A chat this window holds on an SSH machine, and a paired desktop whose chats are its own.
  const box = fakeEnvironment('env-box', [session('w-ssh')])
  const desktop = fakeEnvironment('env-mini', [session('far-1'), session('w-ssh', 's-far-twin')])
  followEnvironmentChats(
    [
      { route: 'ssh:box', name: 'build-box' },
      { route: 'tailnet:c1', name: 'mac-mini' },
    ],
    (target) =>
      createEnvironmentChatSource(target, {
        hold: () => (target.route === 'ssh:box' ? box.hold : desktop.hold),
        settleMs: 1,
      }),
  )
  await settle()
  assert.equal(followedEnvironmentChats().length, 2, 'both are followed: the band and its views read the desktop')
  const records = [{ id: 'w-here' }, { id: 'w-ssh', route: 'ssh:box' }]
  const merged = withEnvironmentSessions(
    {
      list: async () => ({ ok: true as const, sessions: [session('w-here')] }),
      onLifecycleEvent: () => () => undefined,
    },
    (route, workspaceId) => records.some((record) => record.id === workspaceId && record.route === route),
  )
  const listed = await merged.list!()
  assert.ok(listed.ok)
  // Its chat whose id happens to be one this window holds is still that machine's, not this one's.
  assert.deepEqual(
    listed.sessions.map((entry) => entry.sessionId).sort(),
    ['s-w-here', 's-w-ssh'],
    'the window lists its own and its SSH chat; nothing of the desktop',
  )
})

test('a source closed is not read again', async () => {
  const machine = fakeEnvironment('env-box', [])
  const source: EnvironmentChatSource = createEnvironmentChatSource(
    { route: 'ssh:box', name: 'build-box' },
    { hold: () => machine.hold, settleMs: 1 },
  )
  source.subscribe(() => undefined)
  await settle()
  source.close()
  const lists = machine.lists()
  source.refresh()
  await settle()
  assert.equal(machine.lists(), lists)
})
