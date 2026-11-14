import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceSyncCommand, WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import type { Workspace } from '../types/workspace'
import { createWorkspaceSyncClient, type WorkspaceSyncClientApi } from './workspaceSyncClient'

// A window whose Studio restarted out of process while it stayed open: the new
// run numbers its changes from the start, so the window reads the registry
// again when its connection opens, and takes the new run's changes from there.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('after a reconnect the window adopts the registry as it is and hears the new run’s changes', async () => {
  let emit: (event: WorkspaceSyncEvent) => void = () => undefined
  let reopen: () => void = () => undefined
  let snapshot = { sequence: 0, state: { marker: 'first run' } } as unknown as WorkspaceSyncSnapshot
  const api = {
    workspaceSyncDispatch: async () => ({ ok: false, reason: 'x', message: 'x' }),
    workspaceSyncGetSnapshot: async () => snapshot,
    workspaceSyncGetEventsAfter: async () => [],
    onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void, onReopen?: () => void) => {
      emit = cb
      reopen = onReopen ?? (() => undefined)
      return () => undefined
    },
  } as unknown as WorkspaceSyncClientApi
  const adopted: string[] = []
  const renamed: string[] = []
  const ignore = () => undefined
  const client = createWorkspaceSyncClient({
    getApi: () => api,
    getWindowId: () => 'A',
    applyActiveChanged: ignore,
    applyWorkspaceMoved: ignore,
    applyWorkspaceClosed: ignore,
    applyWorkspacePlacement: ignore,
    applyWorkspaceCreated: ignore,
    applyAgentTerminalSession: ignore,
    applyAgentTerminalLaunchState: ignore,
    applyWorkspaceRenamed: (input: { name: string }) => renamed.push(input.name),
    applyWorkspaceLayoutUpdated: ignore,
    applyWorkspaceFieldsUpdated: ignore,
    applyWorkspaceAgentUpdated: ignore,
    applyWorkspaceRemoved: ignore,
    applyRegistrySnapshot: (taken: WorkspaceSyncSnapshot) =>
      adopted.push((taken.state as unknown as { marker: string }).marker),
    logDiagnostic: ignore,
  } as never)
  client.start()
  await settle()
  const rename = (sequence: number, name: string) =>
    ({
      type: 'workspace.renamed',
      sequence,
      payload: { workspaceId: 'w', name },
    }) as unknown as WorkspaceSyncEvent
  for (let sequence = 1; sequence <= 5; sequence++) emit(rename(sequence, `first ${sequence}`))
  await settle()
  assert.equal(renamed.length, 5)

  // The server restarts: its registry is the same, its sequence starts again.
  snapshot = { sequence: 1, state: { marker: 'second run' } } as unknown as WorkspaceSyncSnapshot
  reopen()
  emit(rename(2, 'second 2'))
  await settle()
  assert.deepEqual(adopted, ['first run', 'second run'], 'read again on the reconnect, though its sequence is lower')
  assert.equal(renamed.at(-1), 'second 2', 'the new run’s changes are heard')
})

// A change whose answer a restart took. Studio answers a change only once it
// is on disk, so one with no answer may be gone: the window sends it again
// before it reads the registry, and a new chat starts nothing until Studio has
// it. A kill -9 in between left a conversation, and a first message the agent
// ran, that no chat listed.

type Sent = { type: string; workspaceId?: string; name?: string }

function restartingStudio() {
  const sent: Sent[] = []
  const calls: string[] = []
  const has = new Set<string>()
  const names = new Map<string, string>()
  let reopen: () => void = () => undefined
  // The answers to come, in order: 'lost' throws as a restart does, 'down'
  // too, any other string refuses with that reason; empty, Studio takes it.
  const answers: string[] = []
  const api = {
    workspaceSyncDispatch: async (command: WorkspaceSyncCommand) => {
      const payload = command.payload as { workspace?: { id: string }; workspaceId?: string; name?: string }
      const workspaceId = payload.workspace?.id ?? payload.workspaceId
      sent.push({
        type: command.type,
        ...(workspaceId ? { workspaceId } : {}),
        ...(payload.name ? { name: payload.name } : {}),
      })
      calls.push(`dispatch ${command.type}`)
      const answer = answers.shift()
      if (answer === 'lost')
        throw Object.assign(new Error('Studio restarted; unknown outcome.'), { code: 'unknown_outcome' })
      if (answer) return { ok: false, reason: answer, message: `refused: ${answer}` }
      if (command.type === 'workspace.created') {
        if (has.has(workspaceId!)) return { ok: false, reason: 'workspace_already_exists', message: 'exists' }
        has.add(workspaceId!)
      }
      if (command.type === 'workspace.rename') names.set(workspaceId!, payload.name!)
      return { ok: true, event: { type: 'noop', sequence: 1, payload: {} } }
    },
    workspaceSyncGetSnapshot: async () => {
      calls.push('snapshot')
      return { sequence: 0, state: { workspaces: [...has].map((id) => ({ id, name: names.get(id) })) } }
    },
    workspaceSyncGetEventsAfter: async () => [],
    onWorkspaceSyncEvent: (_cb: unknown, onReopen?: () => void) => {
      reopen = onReopen ?? (() => undefined)
      return () => undefined
    },
  } as unknown as WorkspaceSyncClientApi
  return { api, sent, calls, has, names, answers, reopen: () => reopen() }
}

function windowClient(
  studio: ReturnType<typeof restartingStudio>,
  extra: Partial<Parameters<typeof createWorkspaceSyncClient>[0]> = {},
) {
  const adopted: string[][] = []
  const ignore = () => undefined
  const client = createWorkspaceSyncClient({
    getApi: () => studio.api,
    getWindowId: () => 'primary',
    applyActiveChanged: ignore,
    applyWorkspaceMoved: ignore,
    applyWorkspaceClosed: ignore,
    applyWorkspacePlacement: ignore,
    applyWorkspaceCreated: ignore,
    applyAgentTerminalSession: ignore,
    applyAgentTerminalLaunchState: ignore,
    applyWorkspaceRenamed: ignore,
    applyWorkspaceLayoutUpdated: ignore,
    applyWorkspaceFieldsUpdated: ignore,
    applyWorkspaceAgentUpdated: ignore,
    applyWorkspaceRemoved: ignore,
    applyRegistrySnapshot: (taken: WorkspaceSyncSnapshot) =>
      adopted.push((taken.state as unknown as { workspaces: Array<{ id: string }> }).workspaces.map((each) => each.id)),
    logDiagnostic: ignore,
    ...extra,
  } as never)
  return { client, adopted }
}

const newChat = (id: string) =>
  ({ id, name: 'first message', agents: { a: { chatStartupPrompt: 'first message' } } }) as unknown as Workspace

test('a new chat whose answer a restart took is sent again before the registry is read, and its chat waits for it', async () => {
  const studio = restartingStudio()
  const { client, adopted } = windowClient(studio)
  client.start()
  await settle()
  studio.answers.push('lost')
  const created = client.dispatchCreateWorkspace(newChat('ws-new'), 'primary', '/Users/dev/demo')
  let outcome: unknown = null
  void client.whenCreated('ws-new').then((value) => (outcome = value))
  await created
  studio.reopen()
  await settle()
  await settle()
  assert.deepEqual(outcome, { ok: true }, 'the chat may start once Studio has it')
  assert.ok(studio.has.has('ws-new'), 'Studio has the chat')
  const resent = studio.calls.lastIndexOf('dispatch workspace.created')
  assert.ok(resent > studio.calls.indexOf('dispatch workspace.created'), 'sent again')
  assert.ok(studio.calls.indexOf('snapshot', resent) > resent, 'before the registry is read')
  assert.ok(
    adopted.slice(1).every((ids) => ids.includes('ws-new')),
    'no registry read leaves it out: the chat never leaves the screen',
  )
})

test('a new chat Studio refuses is told, with its first message, and its chat starts nothing', async () => {
  const studio = restartingStudio()
  const told: string[] = []
  const { client } = windowClient(studio, {
    reportUnsavedWorkspace: (workspace: Workspace, message: string) => told.push(`${workspace.id}: ${message}`),
  })
  client.start()
  await settle()
  studio.answers.push('unknown_window')
  const dispatched = client.dispatchCreateWorkspace(newChat('ws-x'), 'primary', null)
  const outcome = client.whenCreated('ws-x')
  await dispatched
  assert.deepEqual(await outcome, { ok: false, message: 'refused: unknown_window' })
  assert.deepEqual(told, ['ws-x: refused: unknown_window'])
})

test('a new chat a reload cut off is sent again when the window starts, and one Studio has counts as made', async () => {
  const studio = restartingStudio()
  let stored: unknown = [
    {
      type: 'workspace.created',
      payload: { workspace: newChat('ws-a'), windowId: 'primary', insert: { kind: 'folder_head', folderPath: null } },
    },
    {
      type: 'workspace.created',
      payload: { workspace: newChat('ws-b'), windowId: 'primary', insert: { kind: 'folder_head', folderPath: null } },
    },
  ]
  studio.has.add('ws-b')
  const { client, adopted } = windowClient(studio, {
    unansweredCreates: { read: () => stored, write: (commands: unknown) => (stored = commands) },
  })
  assert.deepEqual(await client.whenCreated('ws-a'), { ok: true }, 'not waiting before start reads what was kept')
  client.start()
  const outcome = await client.whenCreated('ws-a')
  await settle()
  assert.deepEqual(outcome, { ok: true })
  assert.deepEqual(studio.calls, ['dispatch workspace.created', 'dispatch workspace.created', 'snapshot'])
  assert.deepEqual(adopted, [['ws-b', 'ws-a']])
  assert.deepEqual(stored, [], 'nothing left to send at the next start')
})

test('a rename whose answer a restart took is sent again, and the name stands after the restart', async () => {
  const studio = restartingStudio()
  studio.has.add('ws-1')
  studio.names.set('ws-1', 'Old name')
  const { client } = windowClient(studio)
  client.start()
  await settle()
  studio.answers.push('lost')
  await client.dispatchRenameWorkspace('ws-1', 'New name')
  studio.reopen()
  await settle()
  await settle()
  assert.equal(studio.names.get('ws-1'), 'New name')
  assert.deepEqual(
    studio.sent.filter((each) => each.type === 'workspace.rename').map((each) => each.name),
    ['New name', 'New name'],
  )
})
