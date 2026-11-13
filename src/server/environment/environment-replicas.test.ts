import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import type { Workspace } from '../../renderer/src/types/workspace'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machineStudioClient } from '../../shared/machine-studio-client'
import { emptyWorkspaceRegistryFile, toWorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { createEnvironmentReplicas } from './environment-replicas'

// This desktop's copies of an SSH machine's chats: written only from what the
// machine's own Studio says, a window's record change made there first and here
// as the machine then reads, the window's arrangement kept here, and a machine
// that is not connected refusing in words with the copy left as it was.

const ROUTE = 'ssh:build-box'

function workspace(id: string, folderPath: string | null, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: id,
    mode: 'standard',
    folderPath,
    templateId: 'standard-test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
    ...extra,
  }
}

function syncOf(workspaces: Workspace[], windowId: string) {
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore({
      ...emptyWorkspaceRegistryFile(1),
      revision: 1,
      workspaces: workspaces.map((entry) => toWorkspaceRegistryRecord(entry, 1)),
      workspaceWindows: [
        {
          id: windowId,
          kind: 'primary',
          workspaceIds: workspaces.map((entry) => entry.id),
          activeWorkspaceId: workspaces[0]?.id ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 1,
          lastFocusedAt: 1,
        },
      ],
      primaryWorkspaceWindowId: windowId,
      activeWorkspaceId: workspaces[0]?.id ?? null,
    }),
    now: () => 1234,
  })
  return { registry, sync: createWorkspaceSyncService({ registry, now: () => 1234 }) }
}

const SSH = { kind: 'ssh' as const, id: 'build-box', label: 'build-box' }

function rig(options: { machine?: Workspace[]; desktop?: Workspace[] } = {}) {
  const machine = syncOf(options.machine ?? [workspace('ws-1', '/home/dev/repo')], 'machine-window')
  const desktop = syncOf(
    options.desktop ?? [
      workspace('ws-1', 'ssh://build-box/home/dev/repo', { environment: SSH }),
      workspace('ws-local', '/Users/dev/app'),
    ],
    'primary',
  )
  const asked: Array<{ method: string; params: unknown }> = []
  const listeners: Array<() => void> = []
  let connected = true
  const raw = {
    state: 'open',
    async request(method: string, params: Record<string, unknown>) {
      asked.push({ method, params })
      if (method === 'workspaceSync.snapshot') return machine.sync.getSnapshot()
      if (method === 'workspaceSync.dispatch')
        return machine.sync.dispatch({ command: params.command, sourceWindowId: String(params.windowId) })
      throw new Error(`not served: ${method}`)
    },
    conversations: {},
    subscribe(_topic: string, _params: unknown, listener: { onPayload(payload: unknown): void }) {
      const hear = () => listener.onPayload({})
      listeners.push(hear)
      return () => undefined
    },
  } as unknown as StudioClient
  const client = machineStudioClient(raw, 'build-box')
  const clients: EnvironmentClients = {
    async clientFor(route) {
      if (route !== ROUTE) return { ok: false, code: 'unsupported_route', message: 'Not this one.' }
      return connected
        ? { ok: true, client, name: 'build-box' }
        : { ok: false, code: 'unavailable', message: 'build-box is not connected.' }
    },
    onConnected: () => () => undefined,
  }
  const replicas = createEnvironmentReplicas({ clients, sync: desktop.sync, foldMs: 1 })
  return {
    machine,
    desktop,
    replicas,
    asked,
    machineChanged: () => {
      for (const hear of listeners) hear()
    },
    disconnect: () => {
      connected = false
      ;(raw as { state: string }).state = 'closed'
    },
  }
}

const record = (sync: ReturnType<typeof syncOf>['sync'], id: string) =>
  sync.getSnapshot().state.workspaces.find((entry) => entry.id === id) ?? null

test('following a machine brings its chats here as copies, stamped where they live, and drops one it no longer has', async () => {
  const { desktop, replicas } = rig({
    machine: [workspace('ws-1', '/home/dev/repo', { name: 'Renamed there' }), workspace('ws-born', '/home/dev/other')],
    desktop: [
      workspace('ws-1', 'ssh://build-box/home/dev/repo', { environment: SSH }),
      workspace('ws-gone', 'ssh://build-box/home/dev/old', { environment: SSH }),
      workspace('ws-local', '/Users/dev/app'),
    ],
  })
  await replicas.follow(ROUTE)
  assert.equal(record(desktop.sync, 'ws-1')?.name, 'Renamed there')
  const born = record(desktop.sync, 'ws-born')
  assert.equal(born?.folderPath, 'ssh://build-box/home/dev/other', 'its folder spelled for this computer')
  assert.deepEqual(born?.environment, SSH)
  assert.equal(record(desktop.sync, 'ws-gone'), null, 'a copy the machine no longer has goes')
  assert.ok(record(desktop.sync, 'ws-local'), "this desktop's own chat is untouched")
  // Born there, it joins the primary window without being brought to the front.
  const primary = desktop.sync.getSnapshot().state.workspaceWindows.find((entry) => entry.id === 'primary')
  assert.ok(primary?.workspaceIds.includes('ws-born'))
  assert.notEqual(primary?.activeWorkspaceId, 'ws-born')
})

test('a refresh before the machine holds the records removes nothing here', async () => {
  const { desktop, replicas } = rig({ machine: [] })
  await replicas.refresh(ROUTE)
  assert.ok(record(desktop.sync, 'ws-1'), 'not followed yet: the hand-over has not delivered it')
})

test("a window's rename of a copy is made on the machine first, then here as the machine reads it", async () => {
  const { machine, desktop, replicas, asked } = rig()
  await replicas.follow(ROUTE)
  const answer = await replicas.dispatch({
    type: 'workspace.rename',
    payload: { workspaceId: 'ws-1', name: 'From the window', titleLocked: true, editedAt: 5_000 },
  })
  assert.equal(answer?.ok, true)
  assert.equal(record(machine.sync, 'ws-1')?.name, 'From the window')
  assert.equal(record(desktop.sync, 'ws-1')?.name, 'From the window')
  const sent = asked.find((entry) => entry.method === 'workspaceSync.dispatch')
  assert.equal((sent?.params as { windowId: string }).windowId, 'machine-window', "sent as the machine's own window")
})

test('a New chat on the machine is created there, its folder plain, and comes back here as a copy', async () => {
  const { machine, desktop, replicas, asked } = rig()
  await replicas.follow(ROUTE)
  const answer = await replicas.dispatch({
    type: 'workspace.created',
    payload: {
      workspace: workspace('ws-new', 'ssh://build-box/home/dev/repo', { environment: SSH }),
      windowId: 'primary',
      insert: { kind: 'folder_head', folderPath: 'ssh://build-box/home/dev/repo' },
    },
  })
  assert.equal(answer?.ok, true)
  const there = record(machine.sync, 'ws-new')
  assert.equal(there?.folderPath, '/home/dev/repo')
  assert.equal(there?.environment, undefined, 'the machine is told nothing of where it lives')
  assert.deepEqual(record(desktop.sync, 'ws-new')?.environment, SSH)
  const sent = asked.find((entry) => entry.method === 'workspaceSync.dispatch')?.params as {
    command: { payload: { insert: { folderPath: string } } }
  }
  assert.equal(sent.command.payload.insert.folderPath, '/home/dev/repo')
})

test("the window's arrangement and this desktop's own chats are not the machine's", async () => {
  const { replicas, asked } = rig()
  assert.equal(
    await replicas.dispatch({
      type: 'workspace_window.set_active',
      payload: { windowId: 'primary', workspaceId: 'ws-1' },
    }),
    null,
  )
  assert.equal(
    await replicas.dispatch({
      type: 'workspace.update_layout',
      payload: { workspaceId: 'ws-1', layoutModel: {}, editedAt: 1 },
    }),
    null,
  )
  assert.equal(
    await replicas.dispatch({
      type: 'workspace.rename',
      payload: { workspaceId: 'ws-local', name: 'Mine', editedAt: 1 },
    }),
    null,
  )
  assert.equal(asked.length, 0)
})

test('a machine that is not connected refuses a change in words, and the copy stays as it was', async () => {
  const { desktop, replicas, disconnect } = rig()
  await replicas.follow(ROUTE)
  disconnect()
  const answer = await replicas.dispatch({
    type: 'workspace.rename',
    payload: { workspaceId: 'ws-1', name: 'Lost', editedAt: 9_000 },
  })
  assert.equal(answer?.ok, false)
  assert.ok(answer && !answer.ok && answer.message.includes('build-box is not connected'))
  assert.ok(answer && !answer.ok && answer.snapshot, 'answered with the snapshot to reconcile with')
  assert.equal(record(desktop.sync, 'ws-1')?.name, 'ws-1')
})

test("a change the machine records reaches this desktop's copy without a window asking", async () => {
  const { machine, desktop, replicas, machineChanged } = rig()
  await replicas.follow(ROUTE)
  machine.sync.updateWorkspaceFields('ws-1', { settledAt: 7_000 }, 'system')
  machineChanged()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await replicas.refresh(ROUTE)
  assert.equal(record(desktop.sync, 'ws-1')?.settledAt, 7_000)
})

test("a copy born there takes none of the window's own state from the machine", async () => {
  const { desktop, replicas } = rig({
    machine: [
      workspace('ws-born', '/home/dev/other', {
        editorState: {
          openFiles: [{ path: '/Users/dev/.ssh/id_ed25519' }] as never,
          activeFilePath: '/Users/dev/.ssh/id_ed25519',
        },
      }),
    ],
    desktop: [],
  })
  await replicas.follow(ROUTE)
  const born = record(desktop.sync, 'ws-born')
  assert.deepEqual(born?.editorState, { openFiles: [], activeFilePath: null })
})
