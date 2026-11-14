import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceSyncEvent, WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
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
