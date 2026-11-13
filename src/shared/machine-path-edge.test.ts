import assert from 'node:assert/strict'
import { test } from 'vitest'

import { machinePanePathsIn, machinePanePathsOut, machinePathsIn, machinePathsOut } from './machine-path-edge'
import { machineSpellingOf } from './machine-spelling'

const ssh = (id: string) => machineSpellingOf(`ssh:${id}`)!

test('a path spelled for the machine goes there plain, wherever it is in what is sent', () => {
  const sent = machinePathsIn(ssh('box-1'), {
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
  assert.equal(machinePathsIn(ssh('box-1'), 'ssh://box-2/home/dev'), 'ssh://box-2/home/dev')
  assert.equal(machinePathsIn(ssh('box-1'), '/Users/dev/repo'), '/Users/dev/repo')
})

test('only the members that name a folder or file there come back spelled for this computer', () => {
  const answered = machinePathsOut(ssh('box-1'), {
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
    machinePathsOut(ssh('box-1'), { path: '/home/dev/plan.md' }, new Set(['path'])).path,
    'ssh://box-1/home/dev/plan.md',
  )
})

test("a pane's paths go to the machine plain, and a person's text goes as it was written", () => {
  assert.deepEqual(
    machinePanePathsIn(ssh('box-1'), {
      commandId: 'c1',
      path: 'ssh://box-1/home/dev/repo/notes.md',
      roots: ['ssh://box-1/home/dev/repo'],
      text: 'ssh://box-1/home/dev/repo',
    }),
    {
      commandId: 'c1',
      path: '/home/dev/repo/notes.md',
      roots: ['/home/dev/repo'],
      text: 'ssh://box-1/home/dev/repo',
    },
  )
  assert.deepEqual(
    machinePanePathsIn(ssh('box-1'), {
      repoRoot: 'ssh://box-1/r',
      message: 'ssh://box-1/r',
      ref: { repoRoot: 'ssh://box-1/r' },
    }),
    { repoRoot: '/r', message: 'ssh://box-1/r', ref: { repoRoot: '/r' } },
  )
  assert.deepEqual(machinePanePathsIn(ssh('box-1'), { rootPath: 'ssh://box-1/r', query: 'ssh://box-1/r' }), {
    rootPath: '/r',
    query: 'ssh://box-1/r',
  })
})

test("a pane's answer names the machine's files as this computer spells them, never their contents", () => {
  assert.deepEqual(
    machinePanePathsOut(ssh('box-1'), {
      ok: true,
      results: [{ name: 'a.ts', path: '/home/dev/repo/a.ts', parentPath: '/home/dev/repo', isDir: false }],
    }),
    {
      ok: true,
      results: [
        { name: 'a.ts', path: 'ssh://box-1/home/dev/repo/a.ts', parentPath: 'ssh://box-1/home/dev/repo', isDir: false },
      ],
    },
  )
  assert.deepEqual(
    machinePanePathsOut(ssh('box-1'), {
      repoRoot: '/r',
      files: { 'src/a.ts': { path: 'src/a.ts' } },
      text: '/etc/hosts',
    }),
    { repoRoot: 'ssh://box-1/r', files: { 'src/a.ts': { path: 'src/a.ts' } }, text: '/etc/hosts' },
  )
  assert.deepEqual(machinePanePathsOut(ssh('box-1'), { '/r/a': 1 }), { 'ssh://box-1/r/a': 1 })
  assert.equal(
    machinePanePathsOut(ssh('box-1'), '/* a file that starts with a slash */'),
    '/* a file that starts with a slash */',
  )
})
