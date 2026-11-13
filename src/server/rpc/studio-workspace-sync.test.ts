import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_SCOPES, type StudioGrant } from '../../../packages/studio-protocol/src/public'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import { createStudioWorkspaceSync } from '../workspaces/studio-workspace-sync'
import { studioWindowGrant } from './studio-frame-port'
import { createStudioRpcRouter } from './studio-rpc-router'
import {
  connectLineClient,
  createFakeBackend,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'

// The desktop's own windows' workspace registry over the Studio socket,
// answered by the real registry and sync service: a window seeds its mirror,
// makes a change and hears it on the stream (its own included, which it takes
// once by its sequence), a retried change is recorded once, a window's backup
// goes and comes back, what only a desktop window can say is not taken from a
// browser, a browser on the tailnet makes a workspace only in a folder Studio
// knows, and a paired device reaches none of it, whatever it holds.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function registry() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-workspace-sync-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const workspaceRegistry = createWorkspaceRegistryService({ store: createInMemoryWorkspaceRegistryStore() })
  const workspaceSyncService = createWorkspaceSyncService({ registry: workspaceRegistry })
  const told = { settled: [] as unknown[], runStates: [] as unknown[] }
  const sync = createStudioWorkspaceSync({
    workspaceSyncService,
    workspaceRegistry,
    conversationLifecycle: { fromWindow: () => ({ ok: false, code: 'unknown', message: 'No such chat.' }) },
    settledChatsSettings: { set: (settings: unknown) => void told.settled.push(settings) },
    settlement: { setModuleRunStates: (states: unknown) => void told.runStates.push(states) },
    platform: { paths: { dataDir: () => dataDir } },
  } as never)
  return { sync, told }
}

const PLACEMENT = {
  type: 'workspace_window.update_placement',
  payload: { windowId: 'primary', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMaximized: false },
}

type Frame = {
  t: string
  id?: string
  sub?: string
  ok?: boolean
  error?: { code: string }
  result?: unknown
  payload?: unknown
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = (await line.next((frame) => frame.t === 'welcome')) as unknown as { capabilities: string[] }
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown): Promise<Frame> {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return (await line.next((frame) => frame.t === 'res' && frame.id === id)) as unknown as Frame
    },
    subscribe(topic: string) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params: {} })
      return id
    },
  }
}

const codeOf = (frame: Frame) => (frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null)
const resultOf = <T>(frame: Frame) => {
  assert.equal(codeOf(frame), null, JSON.stringify(frame))
  return frame.result as T
}

test('a window seeds its mirror, makes a change once and hears it on the stream, its own included', async () => {
  const { sync } = registry()
  const started = await startTestServer({ workspaceSync: sync })
  cleanups.push(() => started.dispose())
  const window = await client(started.path, OWNER_TOKEN)
  assert.ok(window.welcome.capabilities.includes('workspace-sync'))

  const snapshot = resultOf<{ sequence: number; state: { workspaces: unknown[] } }>(
    await window.request('workspaceSync.snapshot', {}),
  )
  assert.deepEqual(snapshot.state.workspaces, [])
  const followed = window.subscribe('workspaceSync.events')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const dispatch = { commandId: 'place-once', windowId: 'primary', command: PLACEMENT }
  const answer = resultOf<{ ok: boolean; event: { sequence: number; type: string; sourceWindowId: string } }>(
    await window.request('workspaceSync.dispatch', dispatch),
  )
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(answer.event.sourceWindowId, 'primary')
  const pushed = await window.line.next((frame) => frame.t === 'push' && (frame as unknown as Frame).sub === followed)
  assert.equal((pushed as unknown as { payload: { sequence: number } }).payload.sequence, answer.event.sequence)

  // A retry of the same command is answered from its first answer: one event.
  assert.deepEqual(resultOf(await window.request('workspaceSync.dispatch', dispatch)), answer)
  const { events } = resultOf<{ events: Array<{ sequence: number }> }>(
    await window.request('workspaceSync.eventsAfter', { sequence: snapshot.sequence }),
  )
  assert.deepEqual(
    events.map((event) => event.sequence),
    [answer.event.sequence],
  )

  // A command the registry does not know is its refusal, with the snapshot.
  const unknown = resultOf<{ ok: boolean; snapshot?: unknown }>(
    await window.request('workspaceSync.dispatch', {
      commandId: 'odd',
      windowId: 'primary',
      command: { type: 'nope' },
    }),
  )
  assert.equal(unknown.ok, false)
})

test('the window’s backup goes and comes back, and the hydration offer is answered', async () => {
  const { sync } = registry()
  const started = await startTestServer({ workspaceSync: sync })
  cleanups.push(() => started.dispose())
  const window = await client(started.path, OWNER_TOKEN)
  const missing = resultOf<{ ok: boolean; reason?: string }>(await window.request('workspaceBackup.read', {}))
  assert.deepEqual(missing, { ok: false, reason: 'missing' })
  // An older build's full pair is written as it is; a settings-only one waits on a registry to pair with.
  const payload = { version: 7, writtenAt: '2026-11-13T00:00:00.000Z', data: { registry: '{}', settings: '{}' } }
  assert.equal(
    resultOf<{ ok: boolean }>(await window.request('workspaceBackup.write', { commandId: 'b-1', payload })).ok,
    true,
  )
  assert.deepEqual(resultOf(await window.request('workspaceBackup.read', {})), { ok: true, payload })
  assert.equal(
    codeOf(await window.request('workspaceBackup.write', { commandId: 'b-2', payload: { version: 7 } })),
    'invalid_params',
  )
  assert.equal(
    typeof resultOf<{ needsHydration: boolean }>(await window.request('workspaceRegistry.needsHydration', {}))
      .needsHydration,
    'boolean',
  )
})

test('a paired device reaches none of it, whatever it holds', async () => {
  const { sync } = registry()
  const started = await startTestServer({ workspaceSync: sync })
  cleanups.push(() => started.dispose())
  const app = await client(started.path, pairFakeClient(started.auth, 'app', [...STUDIO_SCOPES]))
  for (const [method, params] of [
    ['workspaceSync.snapshot', {}],
    ['workspaceSync.dispatch', { commandId: 'p-1', windowId: 'primary', command: PLACEMENT }],
    ['workspaceBackup.read', {}],
    ['projectlessChats.root', {}],
  ] as const)
    assert.deepEqual([method, codeOf(await app.request(method, params))], [method, 'owner_required'])
  const followed = app.subscribe('workspaceSync.events')
  const ended = await app.line.next((frame) => (frame as unknown as Frame).sub === followed || frame.t === 'res')
  assert.notEqual(ended.t, 'push')
})

test('a browser’s window-only state is not taken, and a tailnet browser makes a workspace only in a known folder', async () => {
  const { sync, told } = registry()
  const router = createStudioRpcRouter({ backend: createFakeBackend(), info: () => ({}) as never, workspaceSync: sync })
  cleanups.push(() => router.close())
  const grant: StudioGrant = studioWindowGrant()
  const window = { connectionId: 'w', slot: 1, ownWindow: true }
  const tab = { connectionId: 't', slot: 2, ownWindow: false, browser: true }
  const tailnet = { connectionId: 'n', slot: 3, ownWindow: false, browser: true, knownFoldersOnly: true }
  const ask = (method: string, params: unknown, context: object) =>
    router.handle(grant, method as never, params as never, context as never) as Promise<{
      ok: boolean
      result?: { ok?: boolean }
      error?: { code: string }
    }>

  assert.equal((await ask('workspaceSync.setModuleRunStates', { commandId: 'm-1', states: { a: null } }, tab)).ok, true)
  assert.deepEqual(told.runStates, [], 'a tab’s reading is answered and not applied')
  await ask('workspaceSync.setModuleRunStates', { commandId: 'm-2', states: { a: null } }, window)
  assert.deepEqual(told.runStates, [{ a: null }])
  await ask('workspaceSync.setSettledChatsSettings', { commandId: 's-1', settings: { autoSettle: true } }, tab)
  assert.deepEqual(told.settled, [])

  const created = {
    commandId: 'c-1',
    windowId: 'primary',
    command: {
      type: 'workspace.created',
      payload: { insert: { kind: 'folder_head', folderPath: '/Users/dev/elsewhere' } },
    },
  }
  // "No project" is the desktop's: a tab is not told where those chats live, and makes no folder there.
  for (const context of [tab, tailnet]) {
    assert.equal((await ask('projectlessChats.root', {}, context)).error?.code, 'unavailable')
    assert.equal(
      (await ask('projectlessChats.createFolder', { commandId: 'p-1', prompt: 'hi' }, context)).error?.code,
      'unavailable',
    )
  }
  assert.equal((await ask('projectlessChats.root', {}, window)).ok, true)

  const refused = await ask('workspaceSync.dispatch', created, tailnet)
  assert.equal(refused.error?.code, 'invalid_params')
  // Studio's own window names any folder; the registry decides the rest.
  assert.notEqual(
    (await ask('workspaceSync.dispatch', { ...created, commandId: 'c-2' }, window)).error?.code,
    'invalid_params',
  )
})
