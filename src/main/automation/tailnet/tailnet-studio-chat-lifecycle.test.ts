import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import { createStudioChatLifecycleDomain } from '../../../server/chat-lifecycle/chat-lifecycle-domain'
import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../../shared/workspace-sync'
import { createConversationLifecycle } from '../conversation-lifecycle'
import { deviceRig, refusalOf, until, type DeviceRig } from './tailnet-studio.test-helper'

// A paired device's reach to a chat's record on the Studio it lives on
// (`chat-lifecycle`), on the real tailnet listener: a `conversation:operate`
// pairing marks, snoozes, highlights, renames, switches and deletes a chat,
// each once per command id, written as a paired device's; a read-only pairing
// searches and reads a delete's plan but changes nothing; a removed one is
// closed. Served by the real lifecycle over a record of the chats.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Write = { workspaceId: string; patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }

async function rig(): Promise<
  DeviceRig & { records: Map<string, WorkspaceRegistryRecord>; writes: Write[]; deleted: string[] }
> {
  const records = new Map<string, WorkspaceRegistryRecord>([
    ['ws-1', { id: 'ws-1', name: 'Chat 12', createdAt: 10, lastTurnEndedAt: 5_000 } as WorkspaceRegistryRecord],
    ['ws-rest', { id: 'ws-rest', name: 'Old', createdAt: 10, settledAt: 20 } as WorkspaceRegistryRecord],
  ])
  const writes: Write[] = []
  const deleted: string[] = []
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => records.get(workspaceId) ?? null,
    updateWorkspaceFields: (workspaceId, patch, actor) => {
      writes.push({ workspaceId, patch, actor })
      applyWorkspaceFieldsPatch(records.get(workspaceId) as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: (workspaceId, at, actor) => {
      writes.push({ workspaceId, patch: { lastVisitedAt: at }, actor })
      records.get(workspaceId)!.lastVisitedAt = at
      return { ok: true, event: {} as never }
    },
    isWorking: () => false,
    renameWorkspace: (workspaceId, name, actor) => {
      writes.push({ workspaceId, patch: { name } as WorkspaceFieldsPatch, actor })
      records.get(workspaceId)!.name = name
      return { ok: true, event: {} as never }
    },
  })
  const worktree = {
    path: '/Users/dev/.sprintengine-worktrees/app/chat-k',
    name: 'chat-k',
    branch: 'agent/chat-k',
    pooled: false,
    changedPaths: 0,
    unpushedCommits: 1,
    fate: 'remove' as const,
  }
  const chatLifecycle = createStudioChatLifecycleDomain({
    lifecycle,
    deletion: (actor) => ({
      plan: async (ids) =>
        ids.map((workspaceId) => ({
          workspaceId,
          remoteMachine: null,
          worktrees: [worktree],
          ...(records.get(workspaceId)?.settledAt ? {} : { refused: 'Settle it first.' }),
        })),
      delete: async (ids) =>
        ids.map((workspaceId) => {
          if (!records.get(workspaceId)?.settledAt)
            return { workspaceId, ok: false as const, message: 'Settle it first.' }
          records.delete(workspaceId)
          deleted.push(`${workspaceId}:${actor}`)
          return {
            workspaceId,
            ok: true as const,
            worktrees: [{ path: worktree.path, name: 'chat-k', branch: 'agent/chat-k', result: 'removed' as const }],
          }
        }),
    }),
    hasChat: (workspaceId) => records.has(workspaceId),
    searchChats: async (query) => ({
      chats: [
        { workspaceId: 'ws-1', chatTitle: 'Chat 12', hits: [{ agentId: 'agent-1', seq: 3, snippet: query }], count: 1 },
      ],
      truncated: false,
    }),
  })
  const r = await deviceRig({ chatLifecycle })
  cleanups.push(() => r.dispose())
  return Object.assign(r, { records, writes, deleted })
}

test('a pairing that may operate marks, snoozes, highlights, renames and switches a chat, as a paired device', async () => {
  const r = await rig()
  const phone = await r.client(r.pair(['conversation:operate']).token)
  assert.ok(phone.supports('chat-lifecycle'))
  const chat = { workspaceId: 'ws-1' }

  assert.deepEqual(await phone.rpc['conversation.markUnread']({ ...chat, commandId: 'm1' }), { lastVisitedAt: 4_999 })
  const wakesAt = Date.now() + 3_600_000
  assert.deepEqual(await phone.rpc['conversation.snooze']({ ...chat, commandId: 's1', until: wakesAt }), {
    snoozedUntil: wakesAt,
  })
  assert.deepEqual(await phone.rpc['conversation.snooze']({ ...chat, commandId: 's2', until: null }), {
    snoozedUntil: null,
  })
  assert.deepEqual(
    await phone.rpc['conversation.highlight']({ ...chat, commandId: 'h1', starred: true, color: 'blue' }),
    {
      starred: true,
      color: 'blue',
    },
  )
  assert.deepEqual(await phone.rpc['conversation.setAutoSettle']({ ...chat, commandId: 'a1', enabled: true }), {
    enabled: true,
  })
  assert.deepEqual(await phone.rpc['conversation.setAutoCompact']({ ...chat, commandId: 'a2', enabled: false }), {
    enabled: false,
  })
  assert.deepEqual(await phone.rpc['conversation.rename']({ ...chat, commandId: 'r1', name: ' Parser review ' }), {
    name: 'Parser review',
  })
  assert.equal(r.records.get('ws-1')!.name, 'Parser review')
  assert.ok(r.writes.length >= 6)
  assert.ok(
    r.writes.every((write) => write.actor === 'mobile'),
    'every write is recorded as a paired device’s',
  )

  // A settled chat has nowhere to sleep; a chat not here is not found.
  assert.equal(
    await refusalOf(phone.rpc['conversation.snooze']({ workspaceId: 'ws-rest', commandId: 's3', until: wakesAt })),
    'conflict',
  )
  assert.equal(
    await refusalOf(phone.rpc['conversation.rename']({ workspaceId: 'ws-9', commandId: 'r9', name: 'A' })),
    'not_found',
  )
})

test('a change retried under its command id is answered with its first answer and written once', async () => {
  const r = await rig()
  const phone = await r.client(r.pair(['conversation:operate']).token)
  const first = await phone.rpc['conversation.rename']({ workspaceId: 'ws-1', commandId: 'r1', name: 'First' })
  // Another device renames it between the attempt and its retry.
  await phone.rpc['conversation.rename']({ workspaceId: 'ws-1', commandId: 'r2', name: 'Second' })
  const retried = await phone.rpc['conversation.rename']({ workspaceId: 'ws-1', commandId: 'r1', name: 'First' })
  assert.deepEqual(retried, first)
  assert.equal(r.records.get('ws-1')!.name, 'Second', 'the retry did not undo the later rename')
  // The same id for another change is refused, never answered with the first.
  assert.equal(
    await refusalOf(phone.rpc['conversation.rename']({ workspaceId: 'ws-1', commandId: 'r1', name: 'Third' })),
    'command_id_conflict',
  )
})

test('a settled chat’s delete is planned and done once, its worktrees told by name, never by path', async () => {
  const r = await rig()
  const phone = await r.client(r.pair(['conversation:operate']).token)
  const plan = await phone.rpc['conversation.deletePlan']({ workspaceId: 'ws-rest' })
  assert.deepEqual(plan, {
    worktrees: [
      { name: 'chat-k', branch: 'agent/chat-k', pooled: false, changedPaths: 0, unpushedCommits: 1, fate: 'remove' },
    ],
  })
  assert.equal((await phone.rpc['conversation.deletePlan']({ workspaceId: 'ws-1' })).refused, 'Settle it first.')
  assert.equal(await refusalOf(phone.rpc['conversation.delete']({ workspaceId: 'ws-1', commandId: 'd0' })), 'conflict')

  const done = await phone.rpc['conversation.delete']({ workspaceId: 'ws-rest', commandId: 'd1' })
  assert.deepEqual(done, { worktrees: [{ name: 'chat-k', branch: 'agent/chat-k', result: 'removed' }] })
  assert.deepEqual(await phone.rpc['conversation.delete']({ workspaceId: 'ws-rest', commandId: 'd1' }), done)
  // Asked again under a new id, it is gone, as was asked.
  assert.deepEqual(await phone.rpc['conversation.delete']({ workspaceId: 'ws-rest', commandId: 'd2' }), {
    gone: true,
    worktrees: [],
  })
  assert.deepEqual(r.deleted, ['ws-rest:mobile'])
})

test('a read-only pairing searches and reads a plan, and is refused every change; a removed one is closed', async () => {
  const r = await rig()
  const reader = r.pair(['conversation:read'])
  const phone = await r.client(reader.token)
  const found = await phone.rpc['conversation.searchChats']({ query: 'parser' })
  assert.equal(found.chats[0]?.hits[0]?.snippet, 'parser')
  assert.ok(await phone.rpc['conversation.deletePlan']({ workspaceId: 'ws-rest' }))
  for (const call of [
    phone.rpc['conversation.markUnread']({ workspaceId: 'ws-1', commandId: 'x1' }),
    phone.rpc['conversation.rename']({ workspaceId: 'ws-1', commandId: 'x2', name: 'No' }),
    phone.rpc['conversation.delete']({ workspaceId: 'ws-rest', commandId: 'x3' }),
  ])
    assert.equal(await refusalOf(call), 'scope_required')
  assert.equal(r.writes.length, 0)

  // A pairing for workspaces alone does not reach the chats at all.
  const other = await r.client(r.pair(['workspace:read']).token)
  assert.equal(await refusalOf(other.rpc['conversation.searchChats']({ query: 'parser' })), 'scope_required')

  r.devices.revokeDevice(reader.id)
  await until(() => phone.state !== 'open', 'the revoked device to be cut off')
  assert.ok(r.records.has('ws-rest'))
})
