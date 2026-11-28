import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioClient, StudioClientState } from '../../../../packages/client-runtime/src/public'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { withEnvironmentSessions } from '../hooks/conversationSessionsStore'
import {
  createEnvironmentChatSource,
  environmentChatSourceFor,
  environmentResting,
  environmentTargetsToFollow,
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
    grant: { scopes: ['workspaces:read'] },
    request: async (method: string) => {
      // Its rows are read too (`environmentChats.rows.test.ts`); these tests count its sessions.
      if (method === 'conversation.list') return { conversations: [] }
      assert.equal(method, 'session.list')
      lists += 1
      return { ok: true, sessions: [...listed] }
    },
    rpc: { 'workspaces.list': async () => ({ workspaces: [] }) },
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

test('a client that cannot be held is a refusal its caller hears, never an exception thrown at it', async () => {
  // No window to hold it in (a node process, as the cross-client gate runs).
  const source = createEnvironmentChatSource(
    { route: 'ssh:box', name: 'build-box' },
    {
      hold: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'api')")
      },
      settleMs: 1,
    },
  )
  let asked: Promise<unknown> | null = null
  assert.doesNotThrow(() => {
    asked = source.client()
  })
  await assert.rejects(asked!, /reading 'api'/u)
})

test('every environment the list holds is followed by its best route, other than the window’s own Studio', () => {
  const up = { state: 'up', detail: null, lastReachedAt: null } as const
  const stopped = { state: 'unknown', detail: null, lastReachedAt: null } as const
  const targets = environmentTargetsToFollow([
    { displayName: 'This Mac', routes: [{ kind: 'local' }], connection: up },
    { displayName: 'build-box', routes: [{ kind: 'ssh', machine: 'build-box' }], connection: stopped },
    { displayName: 'Ubuntu', routes: [{ kind: 'wsl', distro: 'Ubuntu' }], connection: up },
    { displayName: 'Debian', routes: [{ kind: 'wsl', distro: 'Debian' }], connection: stopped },
    {
      displayName: 'mac-mini',
      routes: [
        { kind: 'tailnet', connection: 'conn-mini' },
        { kind: 'ssh', machine: 'mac-mini' },
      ],
      connection: up,
    },
  ])
  // A WSL distribution that is not running rests: its rows are its last-known
  // list, and nothing is asked of it, which would start it. An SSH machine is
  // followed whatever its state says.
  assert.deepEqual(targets, [
    { route: 'ssh:build-box', name: 'build-box' },
    { route: 'wsl:Ubuntu', name: 'Ubuntu' },
    { route: 'wsl:Debian', name: 'Debian', resting: true },
    { route: 'tailnet:conn-mini', name: 'mac-mini' },
  ])
})

test('a resting environment is drawn and not asked until it runs or a chat on it is opened', () => {
  const made: Array<{ route: string; followed: boolean; closed: boolean }> = []
  const make = (target: { route: string }) => {
    const entry = { route: target.route, followed: false, closed: false }
    made.push(entry)
    return {
      route: target.route,
      snapshot: () => ({}) as never,
      subscribe: () => {
        entry.followed = true
        return () => undefined
      },
      watch: () => () => undefined,
      close: () => {
        entry.closed = true
      },
      loadCached: () => undefined,
    } as unknown as EnvironmentChatSource
  }
  const debian = { route: 'wsl:Debian', name: 'Debian' }
  followEnvironmentChats([{ ...debian, resting: true }], make)
  assert.deepEqual(made, [{ route: 'wsl:Debian', followed: false, closed: false }])
  assert.equal(environmentResting('wsl:Debian'), true)
  // It runs: the same source starts reading it.
  followEnvironmentChats([debian], make)
  assert.deepEqual(made, [{ route: 'wsl:Debian', followed: true, closed: false }])
  assert.equal(environmentResting('wsl:Debian'), false)
  // It stops: its connection goes, and its last-known rows are drawn again.
  followEnvironmentChats([{ ...debian, resting: true }], make)
  assert.equal(made[0]!.closed, true)
  assert.deepEqual(made[1], { route: 'wsl:Debian', followed: false, closed: false })
  // A chat on it is opened: it is followed, and stays followed while a chat view reads through it.
  environmentChatSourceFor(debian)
  assert.equal(made[1]!.followed, true)
  followEnvironmentChats([{ ...debian, resting: true }], make)
  assert.equal(made[1]!.closed, false)
  assert.equal(environmentResting('wsl:Debian'), false)
  followEnvironmentChats([], make)
  assert.equal(made[1]!.closed, true)
})
