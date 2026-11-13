import assert from 'node:assert/strict'
import { test } from 'vitest'

import { machinePathsIn, machinePathsOut } from './machine-path-edge'

test('a path spelled for the machine goes there plain, wherever it is in what is sent', () => {
  const sent = machinePathsIn('box-1', {
    key: { workspaceId: 'w', agentId: 'a', workspaceRoot: 'ssh://box-1/home/dev/repo' },
    mentions: [{ path: 'ssh://box-1/home/dev/repo/a.ts' }, { path: 'src/b.ts' }],
    mcpServers: [{ transport: 'stdio', command: 'ssh://box-1/usr/bin/tool', args: ['--x'] }],
    message: 'look at ssh://box-1/home/dev/repo/a.ts please',
    count: 2,
  })
  assert.deepEqual(sent, {
    key: { workspaceId: 'w', agentId: 'a', workspaceRoot: '/home/dev/repo' },
    mentions: [{ path: '/home/dev/repo/a.ts' }, { path: 'src/b.ts' }],
    mcpServers: [{ transport: 'stdio', command: '/usr/bin/tool', args: ['--x'] }],
    // Words are words: only a whole path is respelled.
    message: 'look at ssh://box-1/home/dev/repo/a.ts please',
    count: 2,
  })
})

test("another machine's path, and this computer's, are sent as they were", () => {
  assert.equal(machinePathsIn('box-1', 'ssh://box-2/home/dev'), 'ssh://box-2/home/dev')
  assert.equal(machinePathsIn('box-1', '/Users/dev/repo'), '/Users/dev/repo')
})

test('only the members that name a folder or file there come back spelled for this computer', () => {
  const answered = machinePathsOut('box-1', {
    ok: true,
    rules: [{ id: 'r', workspaceRoot: '/home/dev/repo', label: '/bin/ls is allowed' }],
    target: { workspaceRoot: '/home/dev/repo', command: '/usr/bin/claude' },
    repoRoot: '/home/dev/repo',
    path: '/home/dev/plan.md',
  })
  assert.deepEqual(answered, {
    ok: true,
    rules: [{ id: 'r', workspaceRoot: 'ssh://box-1/home/dev/repo', label: '/bin/ls is allowed' }],
    target: { workspaceRoot: 'ssh://box-1/home/dev/repo', command: '/usr/bin/claude' },
    repoRoot: 'ssh://box-1/home/dev/repo',
    path: '/home/dev/plan.md',
  })
  assert.equal(
    machinePathsOut('box-1', { path: '/home/dev/plan.md' }, new Set(['path'])).path,
    'ssh://box-1/home/dev/plan.md',
  )
})
