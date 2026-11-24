import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { studioPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import type { ExtensionEventPayloads } from '../../../../packages/extension-sdk/src/events'
import type { TerminalSessionSnapshot } from '../../../../packages/studio-protocol/src/terminals'
import type { ConversationEvent } from '../../../shared/conversation-runtime'
import type { AgentPhaseEvent } from '../../../shared/agent-runtime'
import { ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import { startWorkerHarness, until, type TestExtension, type WorkerHarness } from '../../../../tests/extension-workers'
import { createExtensionEvents, type ExtensionEventSink, type ExtensionEvents } from './extension-events'
import { followStudioEvents, type StudioEventWorkspaceRecord } from './studio-events'

// Studio's events, as extensions hear them: delivered to the workers that list
// them (real worker processes), in order, as the extension's own work, and to
// nobody switched off, stopped or not approved; admitted for a surface by the
// extension's approval and by whoever opened it; and read off Studio's state
// once per change.

const WORKSPACE: ExtensionEventPayloads['workspace.created'] = {
  workspaceId: 'ws-1',
  name: 'Notes',
  kind: 'folder',
  folderPath: '/Users/dev/notes',
  branch: null,
}

// A worker that writes each workspace it hears of to its log, and can stop hearing.
const LISTENER = `
exports.activate = (studio) => {
  const created = studio.events.on('workspace.created', (workspace) => {
    console.log('created ' + workspace.name)
    if (workspace.name === 'stop') created.dispose()
  })
  studio.events.on('workspace.created', (workspace) => console.log('again ' + workspace.name))
  studio.events.on('workspace.removed', async (workspace) => {
    // Its own work: it reads what the person may, as the person who approved it.
    const info = await studio.getWorkspaceGitInfo(workspace.workspaceId).catch((error) => ({ ok: false, message: error.message }))
    console.log('removed ' + workspace.name + ' read ' + (info.ok ? info.branch : 'refused: ' + info.message))
  })
}
`

let harness: WorkerHarness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

function start(extensions: TestExtension[], options: Parameters<typeof startWorkerHarness>[1] = {}): ExtensionEvents {
  harness = startWorkerHarness(extensions, options)
  const events = createExtensionEvents()
  events.bind(harness.workers)
  return events
}

function logOf(key: string): string {
  try {
    return readFileSync(join(harness!.logDir, `${key}.log`), 'utf8')
  } catch {
    return ''
  }
}

const listener = (extra: Partial<TestExtension> = {}): TestExtension => ({
  id: 'listener',
  main: LISTENER,
  permissions: ['workspace:read'],
  events: ['workspace.created', 'workspace.removed'],
  ...extra,
})

test('a worker that lists an event is started to hear it, every handler in order, and one disposed no longer hears it', async () => {
  const events = start([listener()])
  assert.equal(events.wants('workspace.created'), true)
  assert.equal(events.wants('agent.status.changed'), false, 'nothing lists it')
  assert.equal(harness!.workers.status('local.listener')?.state, 'idle', 'not started before an event')
  events.emit('workspace.created', { ...WORKSPACE, name: 'first' })
  events.emit('workspace.created', { ...WORKSPACE, name: 'stop' })
  events.emit('workspace.created', { ...WORKSPACE, name: 'third' })
  await until(() => logOf('local.listener').includes('again third'), 10_000, 'the third event')
  const lines = logOf('local.listener')
    .split('\n')
    .filter((line) => /(created|again) /.test(line))
    .map((line) => line.replace(/^.*\] /, ''))
  assert.deepEqual(lines, ['created first', 'again first', 'created stop', 'again stop', 'again third'])
})

test('a worker that lists workspace.changed hears every workspace as it is when it starts, before anything else', async () => {
  const events = start([
    {
      id: 'watcher',
      main: `exports.activate = (studio) => {
  studio.events.on('workspace.changed', ({ workspace }) => console.log('changed ' + workspace.name))
}`,
      permissions: ['workspace:read'],
      events: ['workspace.changed'],
    },
  ])
  const view = (workspaceId: string, name: string) => ({
    workspace: { ...WORKSPACE, workspaceId, name, terminals: [] },
  })
  events.provide('workspace.changed', () => [view('ws-1', 'Notes'), view('ws-2', 'Site')])
  events.emit('workspace.changed', view('ws-3', 'Later'))
  await until(() => logOf('local.watcher').includes('changed Later'), 10_000, 'the change')
  const lines = logOf('local.watcher')
    .split('\n')
    .filter((line) => / changed /.test(line) || /changed /.test(line))
    .map((line) => line.replace(/^.*\] /, ''))
  assert.deepEqual(lines, ['changed Notes', 'changed Site', 'changed Later'])
})

test('a handler that runs past its time is stopped with its worker, so the next event never runs beside it', async () => {
  const events = start(
    [
      {
        id: 'slow',
        main: `exports.activate = (studio) => {
  studio.events.on('workspace.created', async (workspace) => {
    console.log('begin ' + workspace.name)
    if (workspace.name === 'stuck') await new Promise((resolve) => setTimeout(resolve, 5000))
    console.log('end ' + workspace.name)
  })
}`,
        permissions: ['workspace:read'],
        events: ['workspace.created'],
      },
    ],
    { eventTimeoutMs: 500 },
  )
  events.emit('workspace.created', { ...WORKSPACE, name: 'stuck' })
  events.emit('workspace.created', { ...WORKSPACE, name: 'next' })
  await until(() => logOf('local.slow').includes('end next'), 10_000, 'the next event')
  const log = logOf('local.slow')
  const lines = log
    .split('\n')
    .filter((line) => /(begin|end) /.test(line))
    .map((line) => line.replace(/^.*\] /, ''))
  assert.deepEqual(lines, ['begin stuck', 'begin next', 'end next'], 'the stuck handler never finished beside the next')
  assert.match(log, /event workspace\.created timed out: its handler ran past 1s, so the worker was stopped/)
  assert.doesNotMatch(log, /was not delivered/)
})

test('an event handler runs as the extension’s own work: its calls into Studio are the person’s', async () => {
  const events = start([listener()])
  events.emit('workspace.removed', { ...WORKSPACE, name: 'gone' })
  await until(() => logOf('local.listener').includes('removed gone'), 10_000, 'the removal')
  assert.match(logOf('local.listener'), /removed gone read main/)
})

test('an extension switched off, stopped or no longer approved hears nothing', async () => {
  const events = start([listener(), listener({ id: 'other' })])
  events.emit('workspace.created', { ...WORKSPACE, name: 'before' })
  await until(
    () => logOf('local.listener').includes('created before') && logOf('local.other').includes('created before'),
    10_000,
    'both to hear it',
  )
  // Switched off: unloaded.
  await harness!.workers.detach('local.listener')
  // Its approval revoked: stopped for good.
  harness!.approvals.delete('local.other')
  harness!.workers.reconcile()
  assert.equal(events.wants('workspace.created'), false, 'nobody listens now')
  events.emit('workspace.created', { ...WORKSPACE, name: 'after' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.doesNotMatch(logOf('local.listener'), /created after/)
  assert.doesNotMatch(logOf('local.other'), /created after/)
})

test('a version the kill list removed, or one changed and waiting for approval, hears nothing', async () => {
  const events = start([listener()])
  harness!.installed.set('local.listener', { runnable: false, fingerprint: null })
  harness!.workers.reconcile()
  events.emit('workspace.created', { ...WORKSPACE, name: 'killed' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.doesNotMatch(logOf('local.listener'), /created killed/)
  assert.equal(harness!.workers.status('local.listener')?.state, 'stopped')
})

test('a worker cannot hear an event extension.json does not list', async () => {
  const events = start([
    {
      id: 'sneaky',
      permissions: ['workspace:read'],
      events: ['workspace.created'],
      main: `exports.activate = (studio) => {
        try { studio.events.on('workspace.removed', () => {}) } catch (error) { console.log('refused: ' + error.message) }
        studio.events.on('workspace.created', () => console.log('heard'))
      }`,
    },
  ])
  events.emit('workspace.created', WORKSPACE)
  await until(() => logOf('local.sneaky').includes('heard'), 10_000, 'the listed event')
  assert.match(logOf('local.sneaky'), /refused: Event "workspace\.removed" is not listed/)
})

// ── A surface's subscription ────────────────────────────────────────────────

function sink(grants: Record<string, readonly string[] | null>): ExtensionEventSink {
  return { eventsListed: () => false, deliverEvent: () => undefined, grantOf: (moduleId) => grants[moduleId] ?? null }
}

const device = (permissions: string[]): ExtensionInvoker => ({
  principal: studioPrincipal({ owner: false, permissions: permissions as never }),
  permissionCeiling: 'auto',
  label: 'the device "android-phone"',
})

test('a surface hears an event only when the extension’s approval and whoever opened it both hold its permission', () => {
  const events = createExtensionEvents()
  assert.equal(events.admit('local.a', 'workspace.created', ownerInvoker()).ok, false, 'no extensions loaded yet')
  events.bind(sink({ 'local.a': ['workspace:read'], 'local.b': [] }))
  assert.equal(events.admit('local.a', 'workspace.created', ownerInvoker()).ok, true)
  const unapproved = events.admit('local.b', 'workspace.created', ownerInvoker())
  assert.equal(!unapproved.ok && unapproved.code, 'not_permitted')
  const gone = events.admit('local.c', 'workspace.created', ownerInvoker())
  assert.equal(!gone.ok && gone.code, 'approval_required')
  const paired = events.admit('local.a', 'workspace.created', device(['extension:read']))
  assert.equal(!paired.ok && paired.code, 'not_permitted')
  assert.equal(events.admit('local.a', 'workspace.created', device(['extension:read', 'workspace:read'])).ok, true)
  // An agent's status is part of reading a chat.
  const status = events.admit('local.a', 'agent.status.changed', ownerInvoker())
  assert.equal(!status.ok && status.code, 'not_permitted')
})

test('a connection listening makes an event wanted, hears a copy of each, and stops hearing it', () => {
  const events = createExtensionEvents()
  events.bind(sink({}))
  assert.equal(events.wants('workspace.removed'), false)
  const heard: unknown[] = []
  const stop = events.listen('workspace.removed', (payload) => {
    heard.push(payload)
    ;(payload as { name: string }).name = 'changed by a listener'
  })
  assert.equal(events.wants('workspace.removed'), true)
  const payload = { ...WORKSPACE }
  events.emit('workspace.removed', payload)
  assert.equal(payload.name, 'Notes', 'each listener has its own copy')
  stop()
  events.emit('workspace.removed', payload)
  assert.equal(heard.length, 1)
  assert.equal(events.wants('workspace.removed'), false)
})

// ── Where the events come from ──────────────────────────────────────────────

function studio() {
  let records: StudioEventWorkspaceRecord[] = [
    { id: 'ws-1', name: 'Notes', folderPath: '/Users/dev/notes', agents: { 'agent-1': { name: 'Planner' } } },
  ]
  let sessions: TerminalSessionSnapshot[] = []
  const workspaceListeners = new Set<() => void>()
  const terminalListeners = new Set<() => void>()
  const terminalPhases = new Set<(event: AgentPhaseEvent) => void>()
  const chatListeners = new Set<(event: ConversationEvent) => void>()
  const heard: Array<{ event: string; payload: unknown }> = []
  const events = createExtensionEvents()
  events.bind({
    eventsListed: () => true,
    deliverEvent: (event, payload) => void heard.push({ event, payload }),
    grantOf: () => [],
  })
  const stop = followStudioEvents(events, {
    workspaces: {
      records: () => records,
      subscribe: (listener) => (workspaceListeners.add(listener), () => workspaceListeners.delete(listener)),
    },
    terminals: {
      list: () => sessions,
      onChanged: (listener) => (terminalListeners.add(listener), () => terminalListeners.delete(listener)),
      onAgentPhase: (listener) => (terminalPhases.add(listener), () => terminalPhases.delete(listener)),
    },
    onChatEvent: (listener) => (chatListeners.add(listener), () => chatListeners.delete(listener)),
    now: () => 1_000,
  })
  return {
    heard,
    stop,
    setRecords(next: StudioEventWorkspaceRecord[]) {
      records = next
      for (const listener of workspaceListeners) listener()
    },
    setSessions(next: TerminalSessionSnapshot[]) {
      sessions = next
      for (const listener of terminalListeners) listener()
    },
    /** One of a chat's events, as its runtime records it. */
    chat: (type: ConversationEvent['type'], payload: Record<string, unknown> = {}) => {
      for (const listener of chatListeners)
        listener({
          id: `e-${type}`,
          seq: 1,
          sessionId: 'session-1',
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          type,
          createdAt: 1,
          payload,
        } as ConversationEvent)
    },
    terminalPhase: (event: Partial<AgentPhaseEvent>) => {
      for (const listener of terminalPhases)
        listener({ workspaceId: 'ws-1', agentId: 'agent-2', ...event } as AgentPhaseEvent)
    },
  }
}

const session = (extra: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot =>
  ({
    sessionId: 'terminal-a',
    kind: 'terminal',
    processAlive: true,
    workspaceId: 'ws-1',
    ...extra,
  }) as TerminalSessionSnapshot

test('each commit of the workspaces says what was made, removed or changed, whoever made it, and nothing else', () => {
  const s = studio()
  assert.equal(s.heard.length, 0, 'what is there at the start is no news')
  s.setRecords([
    { id: 'ws-1', name: 'Notes', folderPath: '/Users/dev/notes' },
    { id: 'ws-2', name: 'Site', folderPath: '/Users/dev/site', worktree: { branch: 'feature' } },
  ])
  assert.deepEqual(s.heard, [
    {
      event: 'workspace.created',
      payload: {
        workspaceId: 'ws-2',
        name: 'Site',
        kind: 'worktree',
        folderPath: '/Users/dev/site',
        branch: 'feature',
      },
    },
  ])
  // A commit that changes nothing the events say (a chat's messages) is no event.
  s.heard.length = 0
  s.setRecords([
    { id: 'ws-1', name: 'Notes', folderPath: '/Users/dev/notes', agents: { 'agent-1': { name: 'Planner' } } },
    { id: 'ws-2', name: 'Site', folderPath: '/Users/dev/site', worktree: { branch: 'feature' } },
  ])
  assert.equal(s.heard.length, 0)
  s.setRecords([{ id: 'ws-1', name: 'Notes renamed', folderPath: '/Users/dev/notes' }])
  assert.deepEqual(
    s.heard.map((heard) => heard.event),
    ['workspace.changed', 'workspace.removed'],
  )
  assert.equal((s.heard[1]!.payload as { name: string }).name, 'Site')
  s.stop()
})

test('a terminal opened or closed in a workspace changes it, and lists its terminals', () => {
  const s = studio()
  s.setSessions([
    session({ sessionId: 'terminal-a' }),
    session({ sessionId: 'agent-x', agentId: 'agent-1', kind: 'agent' }),
  ])
  assert.deepEqual(s.heard, [
    {
      event: 'workspace.changed',
      payload: {
        workspace: {
          workspaceId: 'ws-1',
          name: 'Notes',
          kind: 'folder',
          folderPath: '/Users/dev/notes',
          branch: null,
          terminals: [
            { id: 'terminal-a', title: null },
            { id: 'agent-x', title: 'Planner' },
          ],
        },
      },
    },
  ])
  s.heard.length = 0
  s.setSessions([session({ sessionId: 'terminal-a', processAlive: false })])
  assert.deepEqual((s.heard[0]!.payload as ExtensionEventPayloads['workspace.changed']).workspace.terminals, [])
  s.stop()
})

test('an agent’s status is said once per change of state, a chat’s and a terminal agent’s, with its terminal', () => {
  const s = studio()
  s.setSessions([session({ sessionId: 'agent-session', agentId: 'agent-2', kind: 'agent', agentName: 'Builder' })])
  s.heard.length = 0
  s.chat('session_started')
  s.chat('turn_started', { turnId: 't1' })
  s.chat('tool_started', { turnId: 't1', toolUseId: 'u1' })
  s.chat('approval_requested', { requestId: 'r1' })
  s.chat('approval_resolved', { requestId: 'r1' })
  s.chat('turn_completed', { turnId: 't1' })
  s.terminalPhase({ phase: 'thinking', turnFailure: false })
  s.terminalPhase({ phase: 'failed', turnFailure: true })
  const said = s.heard.map((heard) => heard.payload as ExtensionEventPayloads['agent.status.changed'])
  assert.deepEqual(
    said.map(({ where, state, failed }) => `${where}:${state}${failed ? ':failed' : ''}`),
    ['chat:working', 'chat:blocked', 'chat:working', 'chat:done', 'terminal:working', 'terminal:done:failed'],
  )
  assert.equal(said[0]!.title, 'Planner')
  assert.equal(said[0]!.terminalId, null)
  assert.equal(said[5]!.terminalId, 'agent-session')
  assert.equal(said[5]!.title, 'Builder')
  assert.equal(said[5]!.receivedAt, 1_000)
  s.stop()
})

const states = (s: ReturnType<typeof studio>) =>
  s.heard
    .map((heard) => heard.payload as ExtensionEventPayloads['agent.status.changed'])
    .map(({ where, state, failed }) => `${where}:${state}${failed ? ':failed' : ''}`)

test('a chat’s failed turn is failed, one the person stopped is not, and a closed chat is never left working', () => {
  const s = studio()
  s.chat('turn_started', { turnId: 't1' })
  s.chat('turn_failed', { turnId: 't1', message: 'The model refused.' })
  s.chat('session_closed')
  assert.deepEqual(states(s), ['chat:working', 'chat:done:failed'], 'a finished chat’s close says nothing more')
  s.heard.length = 0
  s.chat('turn_started', { turnId: 't2' })
  s.chat('turn_failed', { turnId: 't2', reason: 'interrupted' })
  assert.deepEqual(states(s), ['chat:working', 'chat:done'])
  s.heard.length = 0
  // Closed mid-turn: its last word is done.
  s.chat('turn_started', { turnId: 't3' })
  s.chat('session_closed')
  assert.deepEqual(states(s), ['chat:working', 'chat:done'])
  s.stop()
})

test('a terminal agent that finished says done once, not again when its terminal closes', () => {
  const s = studio()
  s.terminalPhase({ phase: 'thinking', turnFailure: false })
  s.terminalPhase({ phase: 'idle', turnFailure: false, turnEnd: true })
  s.terminalPhase({ phase: 'exited', turnFailure: false })
  assert.deepEqual(states(s), ['terminal:working', 'terminal:done'])
  // Its failure is read beside its phase: idle after a failed turn is a failure.
  s.heard.length = 0
  s.terminalPhase({ phase: 'thinking', turnFailure: false })
  s.terminalPhase({ phase: 'idle', turnFailure: true, turnEnd: true })
  assert.deepEqual(states(s), ['terminal:working', 'terminal:done:failed'])
  s.stop()
})
