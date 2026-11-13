import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioDiscovery } from '../../../server/rpc/studio-rpc-types'
import type { StudioChatBackend } from '../../../server/rpc/studio-rpc-types'
import { createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import type { ConversationSendTurnInput } from '../../../shared/conversation-runtime'
import type { TailnetScope } from '../../../shared/tailnet'
import {
  browsePairedMachine,
  createPairedChat,
  pairedWorkspaceCheckout,
  pairedWorkspaceExtensions,
  tailnetScopesOfGrant,
} from '../../../renderer/src/studio/pairedDiscovery'
import { pairedWindow } from '../../../../tests/paired-window'
import { deviceRig } from './tailnet-studio.test-helper'

// What a desktop window reads of a paired machine before it starts a chat
// there, and the start itself, asked of that machine's Studio by the window's
// own client of it: its projects, a project's checkout and extensions, and
// `conversation.create` with everything New chat asks for. Every machine with
// the protocol takes them all; there is no older shape to ask in.

const discovery: StudioDiscovery = {
  workspaces: async () => [
    {
      id: 'ws-1',
      name: 'parser',
      folderPath: '/Users/dev/parser',
      mode: 'chat',
      settledAt: null,
      repository: {
        canonicalKey: 'github.com/acme/parser',
        remoteUrl: 'git@github.com:acme/parser.git',
        name: 'parser',
      },
    },
    { id: 'ws-2', name: 'notes', folderPath: '/Users/dev/notes', settledAt: 1_700 },
  ],
  runtimes: async () => ({ ok: true, value: { clis: [] } }),
  checkout: async (workspaceId) => ({
    ok: true,
    value: {
      workspaceId,
      git: true,
      branch: 'main',
      defaultBranch: 'main',
      branches: [{ name: 'main', current: true }, { name: 'fix' }] as unknown as string[],
      worktrees: [{ path: '/Users/dev/parser-wt', branch: 'fix' }],
    },
  }),
  extensions: async (workspaceId) => ({
    ok: true,
    value: {
      workspaceId,
      skills: [{ id: 'gh-triage', name: 'GitHub triage', source: 'builtin', installState: 'installed' }, { id: '' }],
      servers: [{ id: 'linear', name: 'linear', transport: 'http', scope: 'user', status: 'connected' }],
    },
  }),
}

/** A chat surface that takes a session's sends, pictures and all. */
function sendingChat(sends: ConversationSendTurnInput[]): StudioChatBackend {
  return {
    sendTurn: async (input: ConversationSendTurnInput) => {
      sends.push(input)
      return { ok: true }
    },
    hasReceipt: async () => false,
    onCommandsChanged: () => () => undefined,
  } as unknown as StudioChatBackend
}

async function pairedMachine(scopes: TailnetScope[] = ['workspace:read', 'conversation:read', 'conversation:operate']) {
  const backend = createFakeBackend(['agent-1'])
  const sends: ConversationSendTurnInput[] = []
  const peer = await deviceRig({ backend, discovery, chat: sendingChat(sends) })
  const window = await pairedWindow(peer, scopes)
  return {
    machine: window.machine,
    backend,
    sends,
    async close() {
      await window.close()
      await peer.dispose()
    },
  }
}

test('a browse reads its projects, the scopes its grant carries now, and what of its chats it keeps', async () => {
  const machine = await pairedMachine()
  try {
    const browse = await browsePairedMachine(machine.machine)
    assert.equal(browse.reachable, true)
    assert.deepEqual(browse.gaps, [])
    assert.deepEqual(browse.scopes, ['workspace:read', 'conversation:read', 'conversation:operate'])
    assert.deepEqual(
      browse.workspaces.map((workspace) => [
        workspace.id,
        workspace.repository?.canonicalKey ?? null,
        workspace.settledAt,
      ]),
      [
        ['ws-1', 'github.com/acme/parser', null],
        ['ws-2', null, 1_700],
      ],
    )
    // The rig serves no chat records and no Stop watching.
    assert.deepEqual(browse.chatRecord, { lifecycle: false, unwatchPullRequest: false })
  } finally {
    await machine.close()
  }
})

test('a pairing that may not read its projects is told so, not shown an empty machine', async () => {
  const machine = await pairedMachine(['conversation:read'])
  try {
    const browse = await browsePairedMachine(machine.machine)
    assert.equal(browse.reachable, true)
    assert.deepEqual(browse.workspaces, [])
    assert.equal(browse.gaps[0]?.code, 'scope_required')
  } finally {
    await machine.close()
  }
})

test('a project’s checkout and what a chat there can use are read member by member', async () => {
  const machine = await pairedMachine()
  try {
    const checkout = await pairedWorkspaceCheckout(machine.machine, 'ws-1')
    assert.deepEqual(checkout, {
      ok: true,
      checkout: {
        workspaceId: 'ws-1',
        git: true,
        branch: 'main',
        defaultBranch: 'main',
        branches: [
          { name: 'main', current: true },
          { name: 'fix', current: false },
        ],
        worktrees: [{ path: '/Users/dev/parser-wt', branch: 'fix', isMain: false }],
      },
    })
    const extensions = await pairedWorkspaceExtensions(machine.machine, 'ws-1', 'claude-code')
    assert.ok(extensions.ok)
    assert.deepEqual(
      extensions.extensions.skills.map((skill) => skill.id),
      ['gh-triage'],
      'a row without an id is left out',
    )
    assert.deepEqual(
      extensions.extensions.servers.map((server) => [server.id, server.status]),
      [['linear', 'connected']],
    )
  } finally {
    await machine.close()
  }
})

test('New chat starts a chat there as a new one, with its worktree, effort and skills, in one create', async () => {
  const machine = await pairedMachine()
  try {
    const created = await createPairedChat(machine.machine, {
      workspaceId: 'ws-1',
      cli: 'claude-code',
      prompt: 'Fix the parser',
      cliModel: 'opus',
      permissionPreset: 'auto',
      effort: 'high',
      worktree: { kind: 'new', name: ' parser-fix ' },
      skills: ['gh-triage'],
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(created.workspaceId, 'ws-1')
    assert.equal(created.agentId, 'created-1')
    const [asked] = machine.backend.creates
    assert.deepEqual(asked?.request, {
      workspaceId: 'ws-1',
      newChat: true,
      cli: 'claude-code',
      prompt: 'Fix the parser',
      model: 'opus',
      permissionPreset: 'auto',
      effort: 'high',
      worktree: true,
      worktreeName: 'parser-fix',
      skills: ['gh-triage'],
    })
    // One in a worktree the project has, by its path; one under no project, naming no workspace.
    await createPairedChat(machine.machine, {
      workspaceId: 'ws-1',
      worktree: { kind: 'existing', path: '/Users/dev/parser-wt' },
    })
    assert.equal(machine.backend.creates[1]?.request.inWorktree, '/Users/dev/parser-wt')
    const refused = await createPairedChat(machine.machine, { noProject: true, cli: 'claude-code' })
    assert.equal(machine.backend.creates[2]?.request.noProject, true)
    assert.equal(machine.backend.creates[2]?.request.workspaceId, undefined)
    // The fake machine has no folder for it, and says so in its own words.
    assert.equal(refused.ok, false)
  } finally {
    await machine.close()
  }
})

test('a chat started with pictures takes its first message with them, staged there under its session', async () => {
  const machine = await pairedMachine()
  try {
    const created = await createPairedChat(machine.machine, {
      workspaceId: 'ws-1',
      prompt: 'What is on this screen?',
      images: [{ id: 'img-1', name: 'screen.png', mediaType: 'image/png', byteLength: 8, dataBase64: 'iVBORw0KGgo=' }],
      skills: ['gh-triage'],
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    // The create carried no prompt and no skills: the first message does.
    const [asked] = machine.backend.creates
    assert.equal(asked?.request.prompt, undefined)
    assert.equal(asked?.request.skills, undefined)
    const [first] = machine.sends
    assert.equal(first?.sessionId, 'session-2')
    assert.equal(first?.message, 'What is on this screen?')
    assert.deepEqual(first?.skills, [{ id: 'gh-triage' }])
    assert.equal(first?.attachments?.length, 1)
  } finally {
    await machine.close()
  }
})

test('a grant’s Studio scopes read back as the pairing’s scopes that carry them', () => {
  assert.deepEqual(tailnetScopesOfGrant(['workspaces:read']), ['workspace:read'])
  assert.deepEqual(tailnetScopesOfGrant(['workspaces:read', 'workspaces:operate', 'conversation:read']), [
    'workspace:read',
    'workspace:operate',
    'conversation:read',
  ])
  assert.deepEqual(tailnetScopesOfGrant(['conversation:read', 'conversation:operate']), ['conversation:read'])
})
