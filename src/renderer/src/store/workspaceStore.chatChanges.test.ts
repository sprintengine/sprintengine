import assert from 'node:assert/strict'
import { beforeAll, test, vi } from 'vitest'

import type { Workspace, WorkspaceWindowState } from '../../../shared/workspace'
import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import type { MeshConversationChange } from '../../../shared/tailnet-mesh'
import type { WorkspaceLifecycleIntent } from '../../../shared/workspace-lifecycle'
import type { LocalChatAnswer } from './localChatRecord'

// A window's Settle, Snooze, Star, colour, Auto-settle and rename land on the
// row at once and are asked of the chat's own Studio by its `conversation.*`
// methods (`localChatRecord.ts`), as another environment's chat is: never as
// a registry command. A refusal puts the row back where it was.

const rested: Array<{ workspaceId: string; intent: WorkspaceLifecycleIntent }> = []
const changed: Array<{ workspaceId: string; change: MeshConversationChange }> = []
let restAnswer: () => Promise<LocalChatAnswer> = async () => ({ ok: true })

vi.mock('./localChatRecord', () => ({
  restLocalChat: ({ id: workspaceId }: { id: string }, intent: WorkspaceLifecycleIntent) => {
    rested.push({ workspaceId, intent })
    return restAnswer()
  },
  changeLocalChat: async ({ id: workspaceId }: { id: string }, change: MeshConversationChange) => {
    changed.push({ workspaceId, change })
    return { ok: true }
  },
}))

const dispatched: string[] = []
let store: typeof import('./workspaceStore')

function windowState(): WorkspaceWindowState {
  return {
    id: 'A',
    kind: 'primary',
    workspaceIds: ['ws-1', 'ws-2'],
    activeWorkspaceId: 'ws-2',
    bounds: null,
    isMaximized: false,
    displayId: null,
    createdAt: 1,
    lastFocusedAt: 1,
  }
}

function workspace(id: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, folderPath: null, agents: {}, createdAt: 1, ...extra } as unknown as Workspace
}

const row = (id: string) => store.useWorkspaceStore.getState().workspaces.find((w) => w.id === id)!

beforeAll(async () => {
  const stored: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value
    },
    removeItem: (key: string) => {
      delete stored[key]
    },
  }
  const snapshot: WorkspaceSyncSnapshot = {
    sequence: 0,
    state: { workspaces: [], activeWorkspaceId: null, primaryWorkspaceWindowId: 'A', workspaceWindows: [] },
  }
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { href: 'http://localhost/?windowId=A' },
      localStorage: localStorageMock,
      api: {
        workspaceSyncDispatch: (command: { type: string }) => {
          dispatched.push(command.type)
          return Promise.resolve({ ok: false as const, reason: 'unseeded', message: 'unseeded' })
        },
        workspaceSyncGetSnapshot: () => Promise.resolve(snapshot),
        workspaceSyncGetEventsAfter: () => Promise.resolve([]),
        onWorkspaceSyncEvent: (_cb: (event: WorkspaceSyncEvent) => void) => () => undefined,
      },
      addEventListener: () => {},
    },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true })
  store = await import('./workspaceStore')
  await store.__workspaceStoreBackupRecoveryPromise
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  store.useWorkspaceStore.setState({
    workspaces: [workspace('ws-1', { lastTerminalActivityAt: 500, lastUserMessageAt: 400 }), workspace('ws-2')],
    activeWorkspaceId: 'ws-2',
    primaryWorkspaceWindowId: 'A',
    workspaceWindows: [windowState()],
    workspaceRegistryEmptyState: null,
  })
})

test('a Settle applies at once and is asked of the chat’s Studio, never as a registry command', async () => {
  rested.length = 0
  dispatched.length = 0
  restAnswer = async () => ({ ok: true })
  const settling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-1', true)
  assert.equal(typeof row('ws-1').settledAt, 'number', 'the row moves before the Studio answers')
  const result = await settling
  assert.equal(result?.ok, true)
  assert.deepEqual(rested, [{ workspaceId: 'ws-1', intent: { kind: 'settle', lastInputAt: 500 } }])
  assert.deepEqual(dispatched, [], 'nothing of the rest goes over the registry')
})

test('a refused Un-settle puts the row back where it was', async () => {
  restAnswer = async () => ({ ok: false, code: 'working', message: 'still working' })
  const before = row('ws-1').settledAt
  const unsettling = store.useWorkspaceStore.getState().setWorkspaceSettled('ws-1', false)
  assert.equal(row('ws-1').settledAt, null, 'applied at once')
  const result = await unsettling
  assert.equal(result?.ok === false && result.code, 'working')
  assert.equal(row('ws-1').settledAt, before, 'and back once the Studio says no')
})

test('a Snooze and a Wake are asked as such, and a page with no Studio leaves the row as applied', async () => {
  rested.length = 0
  restAnswer = async () => ({ ok: false, code: 'unavailable', message: 'no Studio' })
  const wakeAt = Date.now() + 3_600_000
  await store.useWorkspaceStore.getState().setWorkspaceSnoozed('ws-2', wakeAt)
  assert.equal(row('ws-2').snoozedUntil, wakeAt)
  await store.useWorkspaceStore.getState().setWorkspaceSnoozed('ws-2', null)
  assert.deepEqual(
    rested.map((entry) => entry.intent),
    [{ kind: 'snooze', until: wakeAt }, { kind: 'wake' }],
  )
})

test('Star, colour, Auto-settle and a rename are the chat’s conversation methods, not field patches', () => {
  changed.length = 0
  dispatched.length = 0
  const state = store.useWorkspaceStore.getState()
  state.setWorkspaceHighlight('ws-1', { starred: true })
  state.setWorkspaceHighlight('ws-1', { color: 'blue' })
  state.clearWorkspaceHighlight('ws-1')
  state.setWorkspaceAutoSettle('ws-1', true)
  state.renameWorkspace('ws-1', 'Renamed')
  assert.deepEqual(changed, [
    { workspaceId: 'ws-1', change: { kind: 'highlight', starred: true, color: null } },
    { workspaceId: 'ws-1', change: { kind: 'highlight', starred: true, color: 'blue' } },
    { workspaceId: 'ws-1', change: { kind: 'highlight', starred: false, color: null } },
    { workspaceId: 'ws-1', change: { kind: 'auto-settle', enabled: true } },
    { workspaceId: 'ws-1', change: { kind: 'rename', name: 'Renamed' } },
  ])
  assert.equal(row('ws-1').name, 'Renamed')
  assert.deepEqual(dispatched, [], 'no workspace.rename or workspace.update_fields for a row fact')
})
