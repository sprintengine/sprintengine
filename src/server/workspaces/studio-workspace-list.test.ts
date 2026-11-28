import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../shared/workspace'
import { PROJECT_USE_HALF_LIFE_MS, withProjectUse, type ProjectUsageMap } from '../../shared/project-frecency'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { createStudioWorkspaceList } from './studio-workspace-list'

// The list a Studio answers `workspaces.list` and `workspace.list` with. It
// tells a paired phone how much each workspace's project is used, so the
// phone's New lists its projects in the order New chat here does (additive: a
// Studio with no usage to give lists as before), and each row carries what
// its chat's row draws (`chat-rows`).

const NOW = Date.UTC(2026, 9, 6, 12)

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Chat ${id}`,
    mode: 'standard',
    folderPath: null,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
    ...overrides,
  }
}

const WORKSPACES = [
  workspace('ws-app', { folderPath: '/Users/dev/app' }),
  workspace('ws-wt', {
    folderPath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
  }),
  workspace('ws-notes', { folderPath: '/Users/dev/notes' }),
  workspace('ws-none'),
]

function snapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces: WORKSPACES,
      activeWorkspaceId: 'ws-app',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
    },
  }
}

async function list(usage?: ProjectUsageMap, ownOnly = false): Promise<Array<Record<string, unknown>>> {
  const chats = createStudioWorkspaceList({
    snapshot,
    readRepositoryIdentity: async () => null,
    now: () => NOW,
    ...(usage ? { projectUsage: () => usage } : {}),
  })
  return (await chats.list({ ownOnly })).workspaces
}

test('each row carries its project’s score and latest use, scored at the moment of the listing', async () => {
  let usage: ProjectUsageMap = {}
  usage = withProjectUse(usage, '/Users/dev/app', NOW - PROJECT_USE_HALF_LIFE_MS)
  usage = withProjectUse(usage, '/Users/dev/app', NOW)
  const rows = await list(usage)
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byId.get('ws-app')?.projectFrecency, 1.5, 'a use today and one a week ago')
  assert.equal(byId.get('ws-app')?.projectLastUsedAt, new Date(NOW).toISOString())
  // A worktree chat's folder is its own entry in the phone's list, used or not on its own.
  assert.equal(byId.get('ws-wt')?.projectFrecency, 0)
  assert.equal(byId.get('ws-notes')?.projectFrecency, 0, 'never used is 0, so the phone knows the field is served')
  assert.equal(byId.get('ws-notes')?.projectLastUsedAt, null)
  assert.equal(byId.get('ws-none')?.projectFrecency, 0, 'a chat with no folder is no project and never used')
})

test('a Studio with no usage to give lists the rows without the fields', async () => {
  const rows = await list()
  assert.equal(rows.length, WORKSPACES.length)
  for (const row of rows) {
    assert.equal('projectFrecency' in row, false)
    assert.equal('projectLastUsedAt' in row, false)
  }
})

test('each row carries what its chat’s row draws, and leaves out what it has none of (chat-rows)', async () => {
  const marked = workspace('ws-marked', {
    folderPath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
    createdAt: NOW - 10_000,
    lastUserMessageAt: NOW - 5_000,
    lastTurnEndedAt: NOW - 4_000,
    lastVisitedAt: NOW - 3_000,
    scheduledAgentId: 'sched-1',
    snoozedUntil: NOW + 60_000,
    highlight: { starred: true, color: 'blue' },
    autoSettleEnabled: true,
  })
  const asleepLongAgo = workspace('ws-woke', {
    snoozedUntil: NOW - 1,
    highlight: { starred: false, color: 'nope' } as unknown as Workspace['highlight'],
  })
  WORKSPACES.push(marked, asleepLongAgo)
  try {
    const byId = new Map((await list()).map((row) => [row.id, row]))
    const row = byId.get('ws-marked')
    assert.equal(row?.createdAt, NOW - 10_000)
    assert.equal(row?.recencyAt, NOW - 5_000, 'its place is when a person last wrote to it')
    assert.equal(row?.lastUserMessageAt, NOW - 5_000)
    assert.equal(row?.lastTurnEndedAt, NOW - 4_000)
    assert.equal(row?.lastVisitedAt, NOW - 3_000)
    assert.equal(row?.scheduledAgentId, 'sched-1')
    assert.equal(row?.snoozedUntil, NOW + 60_000)
    assert.deepEqual(row?.highlight, { starred: true, color: 'blue' })
    assert.equal(row?.autoSettle, true)
    assert.deepEqual(row?.worktree, { branch: 'agent/login-fix', projectFolder: '/Users/dev/app' })
    const woke = byId.get('ws-woke')
    assert.equal('snoozedUntil' in (woke ?? {}), false, 'a snooze that has run out is a row awake')
    assert.equal('highlight' in (woke ?? {}), false, 'no star and a colour nobody offers is no mark')
    assert.equal('autoSettle' in (woke ?? {}), false)
    assert.equal('worktree' in (woke ?? {}), false)
    assert.equal(woke?.recencyAt, 1, 'a chat nobody wrote to sits where it was made')
  } finally {
    WORKSPACES.splice(WORKSPACES.indexOf(marked), 2)
  }
})

test('asked for its own chats only, it leaves out what another environment holds', async () => {
  const copy = workspace('ws-copy', { folderPath: '/home/dev/app', environment: { kind: 'ssh', id: 'build-box', label: 'dev@build-box' } })
  WORKSPACES.push(copy)
  try {
    assert.ok(
      (await list(undefined, false)).some((row) => row.id === 'ws-copy'),
      'this desktop’s own agents see it',
    )
    assert.ok(!(await list(undefined, true)).some((row) => row.id === 'ws-copy'), 'whoever asks from outside does not')
  } finally {
    WORKSPACES.splice(WORKSPACES.indexOf(copy), 1)
  }
})
