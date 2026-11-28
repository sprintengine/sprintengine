import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { MeshBrowse, MeshConversation, MeshWorkspace } from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../../../shared/workspace'
import {
  canMarkRemoteConversationUnread,
  chatManageOf,
  chatRecordsByAddress,
  environmentChatRows,
  interleaveChats,
  isEnvironmentRecord,
  openSpecOfConversation,
  pendingRemoteMarksRead,
  remoteConversationTitle,
  remoteHighlightAfter,
  remoteLinkStateOf,
  remoteOriginChatWorkspaceId,
  remotePaneTabLabel,
  remoteRowActivity,
  remoteRowFinishUnseen,
  remoteWorkspaceName,
  withPendingRemoteMarks,
  type EnvironmentChatSourceView,
  type RemoteBrowseEntry,
} from './remoteSessionsModel'

// Every other environment's chats as the sidebar's rows (design-environments
// PR 3): by address, from each environment's own lists, whatever kind of
// machine it is.

const MINI_ID = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a'
const BOX_ID = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'

const chat = (workspaceId: string, over: Partial<MeshConversation> = {}): MeshConversation => ({
  workspaceId,
  agentId: 'agent-1',
  title: 'Gael Corry',
  phase: 'completed',
  updatedAt: 1_000,
  createdAt: 500,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 4,
  ...over,
})

const held = (id: string, name: string, over: Partial<MeshWorkspace> = {}): MeshWorkspace => ({
  id,
  name,
  mode: 'standard',
  folderPath: '/Users/dev/app',
  repository: null,
  settledAt: null,
  ...over,
})

const browse = (workspaces: MeshWorkspace[] = []): MeshBrowse => ({
  connectionId: 'c1',
  reachable: true,
  unreachableReason: null,
  unauthorized: false,
  scopes: ['workspace:read', 'conversation:operate'],
  workspaces,
  gaps: [],
})

const source = (
  route: string,
  machineName: string,
  entry: Partial<RemoteBrowseEntry> = {},
  over: Partial<EnvironmentChatSourceView> = {},
): EnvironmentChatSourceView => ({
  route,
  machineName,
  environmentId: route.startsWith('tailnet:') ? MINI_ID : BOX_ID,
  connectionId: route.startsWith('tailnet:') ? route.slice('tailnet:'.length) : null,
  live: true,
  entry: { browse: browse(), loading: false, error: null, at: 1, lifecycle: true, access: 'operate', ...entry },
  ...over,
})

const rows = (sources: EnvironmentChatSourceView[], extra: Partial<Parameters<typeof environmentChatRows>[0]> = {}) =>
  environmentChatRows({ sources, environments: [], records: new Map(), ...extra })

test('a paired desktop’s and an SSH machine’s chats are rows alike, keyed by their address', () => {
  const listed = rows([
    source('tailnet:c1', 'mac-mini', { conversations: [chat('rw1', { lastUserMessageAt: 3_000 })] }),
    source('ssh:build-box', 'build-box', {
      browse: browse([held('sw1', 'Port the parser', { row: { recencyAt: 2_000 } })]),
      conversations: [chat('sw1', { updatedAt: 2_000 })],
    }),
  ])
  assert.deepEqual(
    listed.map((row) => [row.key, row.route, row.connectionId, row.title]),
    [
      [`${MINI_ID}:rw1`, 'tailnet:c1', 'c1', 'Gael Corry'],
      [`${BOX_ID}:sw1`, 'ssh:build-box', null, 'Port the parser'],
    ],
  )
  assert.equal(listed[1]!.address, `${BOX_ID}:sw1`)
})

test('a chat its environment holds is a row whether or not an agent of it is listed', () => {
  const [row, ...rest] = rows([
    source('ssh:build-box', 'build-box', {
      browse: browse([
        held('sw1', 'Terminals only', {
          row: { recencyAt: 4_000, lastTurnEndedAt: 3_500, lastVisitedAt: 1_000, highlight: { starred: true } },
        }),
        held('sw2', 'Resting', { settledAt: 2_000, row: { recencyAt: 5_000 } }),
      ]),
      conversations: [],
    }),
  ])
  assert.equal(rest.length, 0, 'a settled chat has no row')
  assert.equal(row!.title, 'Terminals only')
  assert.deepEqual(row!.agents, [])
  assert.equal(row!.recencyAt, 4_000)
  assert.deepEqual(row!.highlight, { starred: true, color: null })
  // Its clocks are its workspace's: it finished a turn nobody has seen.
  assert.equal(remoteRowFinishUnseen(row!, 10_000), true)
  assert.equal(canMarkRemoteConversationUnread({ ...row!, lastVisitedAt: 4_000 }, 10_000), true)
})

test('a Studio from before `chat-rows` lists only its chats that have an agent', () => {
  const listed = rows([
    source('tailnet:c1', 'mac-mini', {
      browse: browse([held('rw1', 'Listed'), held('rw2', 'Idle seat')]),
      conversations: [chat('rw1', { chatTitle: 'Nightly triage', highlight: { starred: false, color: 'blue' } })],
    }),
  ])
  assert.deepEqual(
    listed.map((row) => row.title),
    ['Nightly triage'],
  )
  assert.deepEqual(listed[0]!.highlight, { starred: false, color: 'blue' }, 'its marks ride its agents')
})

test('rows sit by their environment’s recency key, interleaved across environments', () => {
  const listed = rows([
    source('tailnet:c1', 'mac-mini', {
      conversations: [chat('a', { recencyAt: 1_000 }), chat('b', { recencyAt: 5_000 })],
    }),
    source('ssh:build-box', 'build-box', { conversations: [chat('c', { recencyAt: 3_000 })] }),
  ])
  assert.deepEqual(
    listed.map((row) => row.workspaceId),
    ['b', 'c', 'a'],
  )
  const local = [{ id: 'l1', lastUserMessageAt: 4_000 } as Workspace]
  assert.deepEqual(
    interleaveChats(local, listed, (workspace) => workspace.lastUserMessageAt ?? 0).map((entry) =>
      entry.kind === 'local' ? entry.workspace.id : entry.conversation.workspaceId,
    ),
    ['b', 'l1', 'c', 'a'],
  )
})

test('a chat whose agent waits on a person, or failed, says so; a last-known list claims no live work', () => {
  const [waiting, failed] = rows([
    source('ssh:build-box', 'build-box', {
      conversations: [
        chat('w', { phase: 'waiting_for_approval', recencyAt: 2 }),
        chat('f', { phase: 'failed', recencyAt: 1 }),
      ],
    }),
  ])
  assert.equal(waiting!.activity, 'needs-input')
  assert.equal(remoteRowActivity(failed!), 'failed')
  const [away] = rows([
    source('ssh:build-box', 'build-box', {
      conversations: [chat('w', { phase: 'running' })],
      listFailure: { kind: 'unavailable', message: 'gone' } as never,
      listedAt: 7,
    }),
  ])
  assert.equal(away!.activity, 'idle')
  assert.deepEqual(away!.lastKnown, { reason: 'not-answering', since: 7 })
})

test('a resting WSL distribution draws its last-known rows as not connected', () => {
  const [row] = rows([
    source(
      'wsl:Ubuntu',
      'Ubuntu',
      { conversations: [chat('u1', { phase: 'running' })], listedAt: 40 },
      { live: false, environmentId: null },
    ),
  ])
  assert.deepEqual(row!.lastKnown, { reason: 'not-connected', since: 40 })
  assert.equal(row!.activity, 'idle')
  assert.equal(row!.key, 'wsl:Ubuntu:u1', 'keyed by its route until its id is known')
  assert.equal(row!.address, null)
})

test('off the tailnet a paired desktop’s rows go, and an SSH machine’s stay', () => {
  const listed = rows(
    [
      source('tailnet:c1', 'mac-mini', { conversations: [chat('rw1')] }),
      source('ssh:build-box', 'build-box', { conversations: [chat('sw1')] }),
    ],
    { onTailnet: false, reachedOverTailnet: (route) => route.startsWith('tailnet:') },
  )
  assert.deepEqual(
    listed.map((row) => row.workspaceId),
    ['sw1'],
  )
})

test('a kind of workspace kept off the sidebar is not a row', () => {
  const listed = rows(
    [source('ssh:build-box', 'build-box', { browse: browse([held('b1', 'Board', { mode: 'board', row: {} })]) })],
    { hiddenMode: (mode) => mode === 'board' },
  )
  assert.deepEqual(listed, [])
})

test('a pairing that may only follow a machine’s chats offers no Settle and no marks', () => {
  const [row] = rows([source('tailnet:c1', 'mac-mini', { conversations: [chat('rw1')], access: 'read' as never })])
  assert.equal(row!.lifecycle, false)
  assert.equal(row!.rowMenu, false)
  assert.equal(row!.markUnread, false)
})

test('a record here of another environment’s chat is not a row; opening the chat’s row focuses it', () => {
  const copy = { id: 'sw1', environment: { kind: 'ssh', id: 'build-box', label: 'build-box' } } as Workspace
  const attached = {
    id: 'local-9',
    remoteOrigin: { connectionId: 'c1', workspaceId: 'seat', sessionId: 'conversation:rw1:agent-1' },
  } as Workspace
  const local = { id: 'mine' } as Workspace
  assert.deepEqual([copy, attached, local].map(isEnvironmentRecord), [true, true, false])
  const ids: Record<string, string> = { 'ssh:build-box': BOX_ID, 'tailnet:c1': MINI_ID }
  const records = chatRecordsByAddress([copy, attached, local], (route) => ids[route] ?? null)
  assert.deepEqual(
    [...records],
    [
      [`${BOX_ID}:sw1`, 'sw1'],
      [`${MINI_ID}:rw1`, 'local-9'],
    ],
  )
  const listed = rows(
    [
      source('tailnet:c1', 'mac-mini', { conversations: [chat('rw1')] }),
      source('ssh:build-box', 'build-box', { conversations: [chat('sw1'), chat('sw2', { agentId: 'agent-2' })] }),
    ],
    { records },
  )
  const byChat = new Map(listed.map((row) => [row.workspaceId, row]))
  assert.equal(byChat.get('rw1')!.attachedWorkspaceId, 'local-9')
  assert.equal(byChat.get('sw1')!.attachedWorkspaceId, 'sw1')
  assert.equal(byChat.get('sw2')!.attachedWorkspaceId, null)
  const spec = openSpecOfConversation(byChat.get('sw2')!)
  assert.deepEqual(
    { route: spec.route, connectionId: spec.connectionId, chatId: spec.chatId, agent: spec.agent?.agentId },
    { route: 'ssh:build-box', connectionId: null, chatId: 'sw2', agent: 'agent-2' },
  )
})

test('a mark asked for here is worn at once, and the list stands in for it once a read after the change lands', () => {
  const [row] = rows([source('ssh:build-box', 'build-box', { conversations: [chat('sw1')] })])
  const pending = new Map([
    [row!.key, { route: 'ssh:build-box', marks: { highlight: { starred: true, color: null } }, takenAt: null }],
  ])
  assert.deepEqual(withPendingRemoteMarks([row!], pending)[0]!.highlight, { starred: true, color: null })
  const asked = pending.get(row!.key)!
  assert.equal(
    pendingRemoteMarksRead(asked, () => 10),
    false,
    'not taken yet',
  )
  assert.equal(
    pendingRemoteMarksRead({ ...asked, takenAt: 5 }, () => 4),
    false,
    'no read since',
  )
  assert.equal(
    pendingRemoteMarksRead({ ...asked, takenAt: 5 }, () => 6),
    true,
  )
})

test('a star or colour change keeps the other half, and leaves no highlight when neither is left', () => {
  assert.deepEqual(remoteHighlightAfter(null, { starred: true }), { starred: true, color: null })
  assert.deepEqual(remoteHighlightAfter({ starred: true, color: 'blue' }, { starred: false }), {
    starred: false,
    color: 'blue',
  })
  assert.equal(remoteHighlightAfter({ starred: true, color: null }, { starred: false }), null)
})

test('the helpers a record of another environment’s chat still reads', () => {
  // ── remoteLinkStateOf ────────────────────────────────────────────────────
  // Three answers, not two: "we have not been told" must never read as
  // "disconnected", or a host without the tailnet bridge empties the sidebar.
  assert.equal(remoteLinkStateOf(null), 'unknown')
  assert.equal(remoteLinkStateOf(undefined), 'unknown')
  assert.equal(remoteLinkStateOf({ tailnetAddress: null }), 'down', 'Tailscale is not up on this machine')
  assert.equal(remoteLinkStateOf({ tailnetAddress: '100.64.0.5' }), 'up')

  // ── remotePaneTabLabel ───────────────────────────────────────────────────
  // A remote pane's tab is its agent's name; the machine mark says where it
  // runs (owner, 2026-10-08). A tab saved under the old rule drops the machine.
  assert.equal(remotePaneTabLabel('Aidan Darcy', 'mac-mini.tail1234.ts.net'), 'Aidan Darcy')
  assert.equal(remotePaneTabLabel('Aidan Darcy · mac-mini.tail1234.ts.net', 'mac-mini.tail1234.ts.net'), 'Aidan Darcy')
  assert.equal(
    remotePaneTabLabel('Aidan Darcy · studio', 'mac-mini'),
    'Aidan Darcy · studio',
    'another machine’s name is kept',
  )
  assert.equal(remotePaneTabLabel(' · mac-mini', 'mac-mini'), ' · mac-mini', 'never down to nothing')
  assert.equal(remotePaneTabLabel('Aidan Darcy · mac-mini', undefined), 'Aidan Darcy · mac-mini')

  // ── remoteWorkspaceName / remoteConversationTitle ────────────────────────
  // The CHAT's name, never the agent's (owner, 2026-09-13).
  assert.equal(remoteWorkspaceName('Tara Boyle', 'sprintengine'), 'sprintengine')
  assert.equal(
    remoteWorkspaceName('Tara Boyle', '  '),
    'Tara Boyle',
    'a remote with no name to give falls back to the agent',
  )
  assert.equal(remoteWorkspaceName('Tara Boyle', null), 'Tara Boyle')

  const titled = (name: string, workspaceName: string | undefined) =>
    remoteConversationTitle({ name, remoteOrigin: workspaceName === undefined ? null : ({ workspaceName } as never) })
  assert.equal(
    titled('Tara Boyle · sprintengine', 'sprintengine'),
    'sprintengine',
    'a row stored under the old rule is rescued',
  )
  assert.equal(titled('sprintengine', 'sprintengine'), 'sprintengine', 'a row already named for its chat is left alone')
  assert.equal(titled('Ship the release', 'sprintengine'), 'Ship the release', 'a name a person chose is theirs')
  const listedAs = (name: string, workspaceName: string, listed: string) =>
    remoteConversationTitle({ name, remoteOrigin: { workspaceName } as never }, listed)
  assert.equal(
    listedAs('New chat', 'New chat', 'Fix the release script'),
    'Fix the release script',
    'a row still named as it was born follows the title its machine gives the chat',
  )
  assert.equal(
    listedAs('Ship the release', 'New chat', 'Fix the release script'),
    'Ship the release',
    'a row renamed here keeps the name',
  )
  assert.equal(
    titled(' · sprintengine', 'sprintengine'),
    ' · sprintengine',
    'no agent in front of it: not the old rule, not rewritten',
  )
  assert.equal(
    titled('Tara Boyle · sprintengine', undefined),
    'Tara Boyle · sprintengine',
    'a local row is never touched',
  )
  assert.equal(titled('Tara Boyle', ''), 'Tara Boyle', 'a remote that never named its chat leaves the name as it is')

  console.log('remote sessions model tests passed')
})

test('a remote-born row names its chat by the session it was stamped with', () => {
  assert.equal(
    remoteOriginChatWorkspaceId({ workspaceId: 'seat', sessionId: 'conversation:new-chat:agent-9' }),
    'new-chat',
  )
  assert.equal(remoteOriginChatWorkspaceId({ workspaceId: 'ws:1', sessionId: 'conversation:ws:1:agent-9' }), 'ws:1')
  assert.equal(remoteOriginChatWorkspaceId({ workspaceId: 'seat' }), 'seat', 'a row born before the stamp')
})

test('what of its chats a machine takes from here is read off its Studio’s welcome', () => {
  assert.deepEqual(chatManageOf({ lifecycle: true, unwatchPullRequest: false }), {
    rename: true,
    autoCompact: true,
    unwatchPullRequest: false,
    deleteSettled: true,
    search: true,
  })
  assert.deepEqual(chatManageOf({ lifecycle: false, unwatchPullRequest: true }), {
    rename: false,
    autoCompact: false,
    unwatchPullRequest: true,
    deleteSettled: false,
    search: false,
  })
})
