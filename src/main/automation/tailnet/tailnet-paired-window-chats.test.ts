import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioChatLifecycleDomain } from '../../../server/chat-lifecycle/chat-lifecycle-domain'
import type { StudioPullRequests } from '../../../server/pull-requests/pull-request-domain'
import type { StudioChatBackend } from '../../../server/rpc/studio-rpc-types'
import { createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import type { TailnetScope } from '../../../shared/tailnet'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import {
  changePairedChat,
  pairedApprovalRules,
  pairedChatDeletePlan,
  revokePairedApprovalRule,
  searchPairedChats,
  settlePairedChat,
  visitPairedChat,
} from '../../../renderer/src/studio/pairedChats'
import { browsePairedMachine } from '../../../renderer/src/studio/pairedDiscovery'
import { closePairedStudio, withPairedStudio } from '../../../renderer/src/studio/pairedStudio'
import type { MeshConversationChange } from '../../../shared/tailnet-mesh'
import { pairedWindow } from '../../../../tests/paired-window'
import { deviceRig } from './tailnet-studio.test-helper'

// A paired machine's chats' records, driven by this desktop's window over its
// own client of that machine's Studio: settle and visit, the row menu's marks,
// Rename, Auto compact, Delete with its plan, a search of every chat, its
// always-allow rules and Stop watching. Each change goes once, under a command
// id; a refusal comes back in that machine's words; a machine whose Studio
// does not keep them is told to update.

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
  // Its pull requests, with Stop watching (`pull-request-watch`).
  const pullRequests = {
    list: async () => ({ pullRequests: [] }),
    refresh: async () => ({ asked: false }),
    noteWork: async () => undefined,
    noteToolCall: async () => undefined,
    link: async () => ({ ok: false as const, code: 'not_a_pull_request' as const, message: 'No.' }),
    unwatch: async (input: unknown) => {
      calls.push({ method: 'unwatch', args: [input] })
      return { watched: true }
    },
    onChanged: () => () => undefined,
  } as unknown as StudioPullRequests
  const peer = await deviceRig(
    options.serves === false ? { backend } : { backend, chat, chatLifecycle: fakeLifecycle(calls), pullRequests },
  )
  const window = await pairedWindow(peer, options.scopes ?? ['conversation:read', 'conversation:operate'])
  return {
    machine: window.machine,
    peer,
    window,
    calls,
    async close() {
      await window.close()
      await peer.dispose()
    },
  }
}

test('settle and visit are that machine’s own, by the chat’s workspace there', async () => {
  const machine = await pairedMachine()
  try {
    const there = machine.machine
    assert.deepEqual(await settlePairedChat(there, 'ws-1'), {
      ok: true,
      workspaceId: 'ws-1',
      settledAt: 1_000,
    })
    assert.deepEqual(await settlePairedChat(there, 'ws-1', false), {
      ok: true,
      workspaceId: 'ws-1',
      settledAt: null,
    })
    assert.deepEqual(await visitPairedChat(there, 'ws-1'), {
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
    const change = (change: unknown) => changePairedChat(machine.machine, 'ws-1', change as MeshConversationChange)
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
    const there = machine.machine
    assert.deepEqual(await pairedChatDeletePlan(there, 'ws-1'), {
      ok: true,
      workspaceId: 'ws-1',
      worktrees: [
        { name: 'chat-k', branch: 'agent/chat-k', pooled: false, changedPaths: 0, unpushedCommits: 1, fate: 'remove' },
      ],
    })
    const found = await searchPairedChats(there, ' parser ')
    assert.ok(found.ok)
    assert.deepEqual(found.chats, [
      { workspaceId: 'ws-1', chatTitle: 'Parser', hits: [{ agentId: 'agent-1', seq: 3, snippet: 'parser' }], count: 4 },
    ])
    assert.equal((await searchPairedChats(there, 'p')).ok, false)
    assert.deepEqual(await pairedApprovalRules(there), {
      ok: true,
      rules: [
        { id: 'r1', label: 'Run npm test', toolName: 'Bash', toolKind: 'command', project: 'parser', createdAt: 5 },
      ],
    })
    assert.deepEqual(await revokePairedApprovalRule(there, 'r1'), { ok: true, ruleId: 'r1' })
    assert.deepEqual((await pairedApprovalRules(there)).ok && [], [])
  } finally {
    await machine.close()
  }
})

test('a pairing that may only read is refused every change there, in that machine’s words', async () => {
  const machine = await pairedMachine({ scopes: ['conversation:read'] })
  try {
    const there = machine.machine
    const settled = await settlePairedChat(there, 'ws-1')
    assert.equal(!settled.ok && settled.code, 'scope_required')
    const renamed = await changePairedChat(there, 'ws-1', { kind: 'rename', name: 'A' })
    assert.equal(!renamed.ok && renamed.code, 'scope_required')
    assert.ok((await searchPairedChats(there, 'parser')).ok, 'a search is a read')
    assert.deepEqual(
      machine.calls.map((call) => call.method),
      ['searchChats'],
    )
  } finally {
    await machine.close()
  }
})

test('a machine whose Studio does not keep its chats’ records is told to update', async () => {
  const machine = await pairedMachine({ serves: false })
  try {
    const there = machine.machine
    const renamed = await changePairedChat(there, 'ws-1', { kind: 'rename', name: 'A' })
    assert.equal(!renamed.ok && renamed.code, 'row_menu_unsupported')
    assert.match(!renamed.ok ? renamed.message : '', /Update SprintEngine Studio there/u)
    const settled = await settlePairedChat(there, 'ws-1')
    assert.equal(!settled.ok && settled.code, 'lifecycle_unsupported')
    const found = await searchPairedChats(there, 'parser')
    assert.equal(!found.ok && found.code, 'search_unsupported')
    const rules = await pairedApprovalRules(there)
    assert.equal(!rules.ok && rules.code, 'approval_rules_unsupported')
    assert.deepEqual(machine.calls, [])
  } finally {
    await machine.close()
  }
})

test('Stop watching is the pull request’s own method there, by the chat’s agent and its address', async () => {
  const machine = await pairedMachine()
  try {
    const url = 'https://github.com/acme/app/pull/7'
    assert.deepEqual(
      await changePairedChat(machine.machine, 'ws-1', { kind: 'unwatch-pull-request', agentId: 'agent-1', url }),
      { ok: true, workspaceId: 'ws-1' },
    )
    assert.deepEqual(
      machine.calls.map((call) => [call.method, ...call.args]),
      [['unwatch', { conversation: { workspaceId: 'ws-1', agentId: 'agent-1' }, url }]],
    )
  } finally {
    await machine.close()
  }
})

/** The window's client of the paired machine, as its asks reach it. */
function clientOf(machine: { id: string; machineName: string }): Promise<StudioClient> {
  return withPairedStudio(machine, async (client) => client)
}

/** Whether a client closes for good within a while. */
async function closesSoon(client: StudioClient): Promise<boolean> {
  const closed = client.closed.then(
    () => true,
    () => true,
  )
  return Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))])
}

test('each connection is opened with a ticket of its own, from the window’s origin, and the window keeps none', async () => {
  const machine = await pairedMachine()
  try {
    await settlePairedChat(machine.machine, 'ws-1')
    assert.equal(machine.window.tickets(), 1)
    // Asked again on the same connection: no new ticket.
    await visitPairedChat(machine.machine, 'ws-1')
    assert.equal(machine.window.tickets(), 1)
    // A new connection asks for a new one; the spent one opens nothing.
    closePairedStudio(machine.machine.id)
    await visitPairedChat(machine.machine, 'ws-1')
    assert.equal(machine.window.tickets(), 2)
    // A ticket for no origin, or another's, is no window's: the listener refuses its socket.
    const ticket = await machine.window.api.environmentsTicket(`tailnet:${machine.machine.id}`)
    assert.ok(ticket.ok)
    const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string) => WebSocket }).WebSocket
    const refused = await new Promise<boolean>((resolve) => {
      const socket = new NodeWebSocket(ticket.url)
      socket.addEventListener('open', () => resolve(false))
      socket.addEventListener('error', () => resolve(true))
      socket.addEventListener('close', () => resolve(true))
    })
    assert.equal(refused, true)
  } finally {
    await machine.close()
  }
})

test('a pairing that machine revokes closes the window’s client, and the next ask is refused', async () => {
  const machine = await pairedMachine()
  try {
    const client = await clientOf(machine.machine)
    const [device] = machine.peer.devices.listDevices()
    assert.ok(device)
    machine.peer.devices.revokeDevice(device.id)
    assert.equal(await closesSoon(client), true)
    const settled = await settlePairedChat(machine.machine, 'ws-1')
    assert.equal(!settled.ok && settled.code, 'unauthorized')
    // A browse says so, as the one failure pairing again fixes, not as a machine away.
    const browse = await browsePairedMachine({ ...machine.machine })
    assert.equal(browse.reachable, false)
    assert.equal(browse.unauthorized, true)
  } finally {
    await machine.close()
  }
})

test('a pairing forgotten here closes the window’s client, and no ticket is bought for it again', async () => {
  const machine = await pairedMachine()
  try {
    const client = await clientOf(machine.machine)
    machine.window.mesh.forget(machine.machine.id)
    machine.window.environmentsChanged()
    assert.equal(await closesSoon(client), true)
    const ticket = await machine.window.api.environmentsTicket(`tailnet:${machine.machine.id}`)
    assert.equal(!ticket.ok && ticket.code, 'unknown_route')
  } finally {
    await machine.close()
  }
})
