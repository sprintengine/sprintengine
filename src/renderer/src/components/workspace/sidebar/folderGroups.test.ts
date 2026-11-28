import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../../../../shared/workspace'
import {
  buildFolderGroups,
  folderDisplayName,
  newChatProjectTarget,
  projectKeyOf,
  remoteGroupDisplayName,
  remoteProjectFolder,
  remoteProjectName,
  resolveGroups,
} from './folderGroups'

const ROOT = '/Users/dev/.sprintengine/chats'

function chat(id: string, folderPath: string | null): Workspace {
  return { id, name: id, folderPath, createdAt: 1 } as unknown as Workspace
}

test('the chats started without a project share one "No project" header', () => {
  const rows = [
    chat('a', `${ROOT}/2026-10-10-hello-ab12cd34`),
    chat('b', '/Users/dev/app'),
    chat('c', `${ROOT}/2026-10-11-plan-a-trip-0a1b2c3d`),
  ]
  // As the sidebar builds them: keys and headers resolved first.
  const resolved = resolveGroups(rows)
  const groups = buildFolderGroups(rows, (workspace) => resolved.keys.get(workspace.id) ?? '', resolved.headers)
  assert.deepEqual(
    groups.map((group) => [group.displayName, group.fullPath, group.workspaces.map((workspace) => workspace.id)]),
    [
      ['No project', ROOT, ['a', 'c']],
      ['app', '/Users/dev/app', ['b']],
    ],
  )
  assert.equal(folderDisplayName(ROOT), 'No project')
  assert.equal(folderDisplayName(null), 'No folder', 'the folderless bucket keeps its name')
})

test('New chat from a chat without a project starts another one, not a chat in its folder', () => {
  assert.equal(newChatProjectTarget(chat('a', `${ROOT}/2026-10-10-hello-ab12cd34`)), ROOT)
})

const MINI_ROOT = '/Users/me/.sprintengine/chats'

// Which header a chat files under, whichever environment it is on (`projectKeyOf`).
const key = (
  environmentId: string,
  projectFolder: string | null,
  over: { repository?: string; projectless?: boolean } = {},
  local: { byRepository?: Map<string, string>; projectlessKey?: string | null } = {},
) =>
  projectKeyOf(
    {
      environmentId,
      projectFolder,
      repository: over.repository ? ({ canonicalKey: over.repository } as never) : null,
      projectless: over.projectless === true,
    },
    { byRepository: local.byRepository ?? new Map(), projectlessKey: local.projectlessKey ?? null },
  )

test('one repository on this computer, an SSH machine and a paired desktop is one header', () => {
  const repo = 'github.com/acme/demo-app'
  const local = { byRepository: new Map([[repo, '/users/dev/demo-app']]) }
  assert.equal(key('env-box', '/home/dev/demo-app', { repository: repo }, local), '/users/dev/demo-app')
  assert.equal(key('env-mini', '/Users/me/demo', { repository: repo }, local), '/users/dev/demo-app')
  // With no clone here, the repository is still one header across machines.
  assert.equal(key('env-box', '/a', { repository: repo }), key('env-mini', '/b', { repository: repo }))
})

test('a folder with no repository is a header per environment: the same path on two machines is two folders', () => {
  assert.notEqual(key('env-box', '/Users/dev/app'), key('env-mini', '/Users/dev/app'))
  assert.equal(key('env-box', '/Users/dev/app'), key('env-box', '/Users/dev/app/'))
})

test('chats started without a project on every machine share one "No project" header', () => {
  assert.equal(key('env-box', `${MINI_ROOT}/x`, { projectless: true }), key('env-mini', null, { projectless: true }))
  const rows = [chat('b', `${ROOT}/2026-10-10-hello-ab12cd34`), chat('d', '/Users/me/app')]
  const resolved = resolveGroups(rows)
  assert.equal(resolved.projectlessKey, resolved.keys.get('b'))
  assert.equal(
    key('env-box', `${MINI_ROOT}/x`, { projectless: true }, { projectlessKey: resolved.projectlessKey }),
    resolved.keys.get('b'),
    "they join this window's own No project header, so its New chat starts here",
  )
})

const SLOT = '/Users/dev/.sprintengine-worktrees/demo-app/demo-app-04'

function openedFrom(id: string, workspaceRoot: string | null): Workspace {
  return {
    ...chat(id, null),
    remoteOrigin: { connectionId: 'c1', machineName: 'mac-mini', workspaceId: id, workspaceRoot, repository: null },
  } as unknown as Workspace
}

test('a chat in a pool slot on a paired machine is named for its project', () => {
  assert.equal(remoteProjectName(SLOT, 'mac-mini'), 'demo-app')
  assert.equal(remoteProjectName(`${SLOT}/`, 'mac-mini'), 'demo-app', 'a trailing separator changes nothing')
  assert.equal(
    remoteProjectName('C:\\dev\\.sprintengine-worktrees\\demo-app\\chat-k_iq', 'build-box'),
    'demo-app',
    'on a Windows machine too',
  )
  assert.equal(remoteGroupDisplayName(openedFrom('a', SLOT)), 'demo-app', 'a row opened here too')
  assert.equal(remoteProjectFolder(SLOT), '/Users/dev/demo-app')
})

test('a nested worktree on a paired machine is named for the project, not the worktree it was cut from', () => {
  const nested = '/Users/dev/.sprintengine-worktrees/demo-app/.sprintengine-worktrees/demo-app-04/chat-1'
  assert.equal(remoteProjectName(nested, 'mac-mini'), 'demo-app')
})

test('a folder on a paired machine that is not an app-made worktree keeps its own name', () => {
  assert.equal(remoteProjectName('/Users/dev/demo-app', 'mac-mini'), 'demo-app')
  assert.equal(remoteProjectName('/Users/dev/worktrees/demo-app-04', 'mac-mini'), 'demo-app-04')
  assert.equal(remoteProjectName(null, 'mac-mini.tail1234.ts.net'), 'mac-mini', 'no folder still names the machine')
  assert.equal(remoteProjectName(`${MINI_ROOT}/2026-10-10-hello-ab12cd34`, 'mac-mini'), 'No project')
})

test('the slots of a project with no repository share one header with its checkout', () => {
  const folders = [SLOT, '/Users/dev/.sprintengine-worktrees/demo-app/demo-app-07', '/Users/dev/demo-app']
  assert.equal(new Set(folders.map((folder) => key('env-mini', remoteProjectFolder(folder)))).size, 1)
})

test('a record of an SSH machine’s worktree chat is named for its project', () => {
  const environment = { id: 'env1', label: 'build-box' }
  const worktree = { ...chat('a', SLOT), environment } as unknown as Workspace
  assert.equal(remoteGroupDisplayName(worktree), 'demo-app')
})
