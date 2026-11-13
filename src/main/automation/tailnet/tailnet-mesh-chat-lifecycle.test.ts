import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { StudioChatLifecycleDomain } from '../../../server/chat-lifecycle/chat-lifecycle-domain'
import type { StudioChatBackend } from '../../../server/rpc/studio-rpc-types'
import { createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import type { TailnetScope } from '../../../shared/tailnet'
import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { deviceRig } from './tailnet-studio.test-helper'

// A paired machine's chats' records, driven from here over its Studio: settle
// and visit, the row menu's marks, Rename, Auto compact, Delete with its plan,
// a search of every chat, and its always-allow rules. Each change goes once,
// under a command id; a refusal comes back in that machine's words; a machine
// whose Studio does not keep them is told to update, and its list offers none.

type Call = { method: string; args: unknown[] }

function fakeLifecycle(calls: Call[]): StudioChatLifecycleDomain {
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args })
  return {
    markUnread: async (workspaceId, byOwner) => (
      note('markUnread', workspaceId, byOwner),
      { ok: true, value: { lastVisitedAt: 41 } }
    ),
    snooze: async (workspaceId, until) =>
      until !== null && until < 10
        ? { ok: false, code: 'conflict', message: 'An agent in this chat is still working.' }
        : (note('snooze', workspaceId, until), { ok: true, value: { snoozedUntil: until } }),
    highlight: async (workspaceId, change) => (
      note('highlight', workspaceId, change),
      { ok: true, value: { starred: change.starred ?? false, color: change.color ?? null } }
    ),
    setAutoSettle: async (workspaceId, enabled) => (
      note('setAutoSettle', workspaceId, enabled),
      { ok: true, value: { enabled } }
    ),
    setAutoCompact: async (workspaceId, enabled) => (
      note('setAutoCompact', workspaceId, enabled),
      { ok: true, value: { enabled } }
    ),
    rename: async (workspaceId, name) => (note('rename', workspaceId, name), { ok: true, value: { name } }),
    deletePlan: async (workspaceId) => (
      note('deletePlan', workspaceId),
      {
        ok: true,
        value: {
          worktrees: [
            {
              name: 'chat-k',
              branch: 'agent/chat-k',
              pooled: false,
              changedPaths: 0,
              unpushedCommits: 1,
              fate: 'remove',
            },
          ],
        },
      }
    ),
    delete: async (workspaceId) => (note('delete', workspaceId), { ok: true, value: { worktrees: [] } }),
    searchChats: async (query) => (
      note('searchChats', query),
      {
        chats: [
          {
            workspaceId: 'ws-1',
            chatTitle: 'Parser',
            hits: [{ agentId: 'agent-1', seq: 3, snippet: query }],
            count: 4,
          },
        ],
        truncated: false,
      }
    ),
  }
}

async function pairedMachine(options: { serves?: boolean; scopes?: TailnetScope[] } = {}) {
  const calls: Call[] = []
  const backend = Object.assign(createFakeBackend(['agent-1']), {
    followed: {
      settle: (workspaceId: string, settled: boolean) => {
        calls.push({ method: 'settle', args: [workspaceId, settled] })
        return { ok: true as const, settledAt: settled ? 1_000 : null }
      },
      visit: (workspaceId: string) => {
        calls.push({ method: 'visit', args: [workspaceId] })
        return { ok: true as const, lastVisitedAt: 2_000 }
      },
    },
  })
  // The chat surface's always-allow rules, read with their folder there.
  let rules = [
    {
      id: 'r1',
      workspaceRoot: '/Users/dev/parser',
      toolKind: 'command' as const,
      toolName: 'Bash',
      matcher: { type: 'command' as const, program: 'npm', subcommand: 'test' },
      label: 'Run npm test',
      createdAt: 5,
    },
  ]
  const chat = {
    approvalRules: async () => ({ ok: true as const, rules }),
    revokeApprovalRule: async (ruleId: string) => {
      calls.push({ method: 'revokeApprovalRule', args: [ruleId] })
      rules = rules.filter((rule) => rule.id !== ruleId)
      return { ok: true as const }
    },
    onCommandsChanged: () => () => undefined,
  } as unknown as StudioChatBackend
  const peer = await deviceRig(
    options.serves === false ? { backend } : { backend, chat, chatLifecycle: fakeLifecycle(calls) },
  )
  const offer = peer.devices.offerPairing({ scopes: options.scopes ?? ['conversation:read', 'conversation:operate'] })
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-chat-lifecycle-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', peer.port(), offer.token) })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  return {
    mesh,
    connectionId: paired.connection.id,
    calls,
    async close() {
      mesh.shutdown()
      await peer.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('settle and visit are that machine’s own, by the chat’s workspace there', async () => {
  const machine = await pairedMachine()
  try {
    const { mesh, connectionId } = machine
    assert.deepEqual(await mesh.settleConversation({ connectionId, workspaceId: 'ws-1' }), {
      ok: true,
      workspaceId: 'ws-1',
      settledAt: 1_000,
    })
    assert.deepEqual(await mesh.settleConversation({ connectionId, workspaceId: 'ws-1', settled: false }), {
      ok: true,
      workspaceId: 'ws-1',
      settledAt: null,
    })
    assert.deepEqual(await mesh.visitConversation({ connectionId, workspaceId: 'ws-1' }), {
      ok: true,
      workspaceId: 'ws-1',
      lastVisitedAt: 2_000,
    })
    assert.deepEqual(
      machine.calls.map((call) => [call.method, ...call.args]),
      [
        ['settle', 'ws-1', true],
        ['settle', 'ws-1', false],
        ['visit', 'ws-1'],
      ],
    )
  } finally {
    await machine.close()
  }
})

test('each row menu and management change is that machine’s own method, written as a paired device’s', async () => {
  const machine = await pairedMachine()
  try {
    const change = (change: unknown) =>
      machine.mesh.changeConversation({ connectionId: machine.connectionId, workspaceId: 'ws-1', change })
    for (const asked of [
      { kind: 'snooze', until: 5_000.7 },
      { kind: 'highlight', starred: true, color: 'blue' },
      { kind: 'auto-settle', enabled: true },
      { kind: 'mark-unread' },
      { kind: 'rename', name: ' Parser review ' },
      { kind: 'auto-compact', enabled: false },
      { kind: 'delete' },
    ])
      assert.deepEqual(await change(asked), { ok: true, workspaceId: 'ws-1' }, JSON.stringify(asked))
    assert.deepEqual(
      machine.calls.map((call) => [call.method, ...call.args]),
      [
        ['snooze', 'ws-1', 5_000],
        ['highlight', 'ws-1', { starred: true, color: 'blue' }],
        ['setAutoSettle', 'ws-1', true],
        ['markUnread', 'ws-1', false],
        ['rename', 'ws-1', 'Parser review'],
        ['setAutoCompact', 'ws-1', false],
        ['delete', 'ws-1'],
      ],
    )
    // A refusal there comes back in that machine's words; a change it cannot read is refused here.
    assert.deepEqual(await change({ kind: 'snooze', until: 5 }), {
      ok: false,
      code: 'conflict',
      message: 'An agent in this chat is still working.',
    })
    assert.equal((await change({ kind: 'highlight' })).ok, false)
    assert.equal((await change({ kind: 'rename', name: '  ' })).ok, false)
  } finally {
    await machine.close()
  }
})

test('Delete’s plan, the search and the always-allow rules are read there, a project by its folder’s name', async () => {
  const machine = await pairedMachine()
  try {
    const { mesh, connectionId } = machine
    assert.deepEqual(await mesh.conversationDeletePlan({ connectionId, workspaceId: 'ws-1' }), {
      ok: true,
      workspaceId: 'ws-1',
      worktrees: [
        { name: 'chat-k', branch: 'agent/chat-k', pooled: false, changedPaths: 0, unpushedCommits: 1, fate: 'remove' },
      ],
    })
    const found = await mesh.conversationSearch({ connectionId, query: ' parser ' })
    assert.ok(found.ok)
    assert.deepEqual(found.chats, [
      { workspaceId: 'ws-1', chatTitle: 'Parser', hits: [{ agentId: 'agent-1', seq: 3, snippet: 'parser' }], count: 4 },
    ])
    assert.equal((await mesh.conversationSearch({ connectionId, query: 'p' })).ok, false)
    assert.deepEqual(await mesh.approvalRules({ connectionId }), {
      ok: true,
      rules: [
        { id: 'r1', label: 'Run npm test', toolName: 'Bash', toolKind: 'command', project: 'parser', createdAt: 5 },
      ],
    })
    assert.deepEqual(await mesh.revokeApprovalRule({ connectionId, ruleId: 'r1' }), { ok: true, ruleId: 'r1' })
    assert.deepEqual((await mesh.approvalRules({ connectionId })).ok && [], [])
  } finally {
    await machine.close()
  }
})

test('a pairing that may only read is refused every change there, in that machine’s words', async () => {
  const machine = await pairedMachine({ scopes: ['conversation:read'] })
  try {
    const { mesh, connectionId } = machine
    const settled = await mesh.settleConversation({ connectionId, workspaceId: 'ws-1' })
    assert.equal(!settled.ok && settled.code, 'scope_required')
    const renamed = await mesh.changeConversation({
      connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'rename', name: 'A' },
    })
    assert.equal(!renamed.ok && renamed.code, 'scope_required')
    assert.ok((await mesh.conversationSearch({ connectionId, query: 'parser' })).ok, 'a search is a read')
    assert.deepEqual(
      machine.calls.map((call) => call.method),
      ['searchChats'],
    )
  } finally {
    await machine.close()
  }
})

test('a machine whose Studio does not keep its chats’ records is told to update, and its list offers none of them', async () => {
  const machine = await pairedMachine({ serves: false })
  try {
    const { mesh, connectionId } = machine
    const renamed = await mesh.changeConversation({
      connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'rename', name: 'A' },
    })
    assert.equal(!renamed.ok && renamed.code, 'row_menu_unsupported')
    assert.match(!renamed.ok ? renamed.message : '', /Update SprintEngine Studio there/u)
    const settled = await mesh.settleConversation({ connectionId, workspaceId: 'ws-1' })
    assert.equal(!settled.ok && settled.code, 'lifecycle_unsupported')
    const found = await mesh.conversationSearch({ connectionId, query: 'parser' })
    assert.equal(!found.ok && found.code, 'search_unsupported')
    const rules = await mesh.approvalRules({ connectionId })
    assert.equal(!rules.ok && rules.code, 'approval_rules_unsupported')
    assert.deepEqual(machine.calls, [])
  } finally {
    await machine.close()
  }
})
