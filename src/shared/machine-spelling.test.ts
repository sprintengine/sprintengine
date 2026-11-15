import assert from 'node:assert/strict'
import { test } from 'vitest'

import { environmentRouteOfRecord } from './environment-clients'
import { machinePanePathsIn, machinePathsIn, machinePathsOut } from './machine-path-edge'
import { machineRouteOfPath, machineSpellingOf } from './machine-spelling'

// How this computer spells another machine's paths, and that machine its own
// (design-wsl-ssh-direct PR 3c): an SSH machine's `ssh://<id>/…`, a WSL
// distribution's share and the Windows drives it mounts.

test("a WSL distribution's share and drives go there as its own paths, and come back as Windows opens them", () => {
  const wsl = machineSpellingOf('wsl:Ubuntu')!
  assert.equal(wsl.toMachine('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), '/home/dev/repo')
  assert.equal(
    wsl.toMachine('\\\\wsl$\\ubuntu\\home\\dev\\my repo'),
    '/home/dev/my repo',
    'the share either way, any case',
  )
  assert.equal(wsl.toMachine('//wsl.localhost/Ubuntu/srv'), '/srv', 'forward slashes, as Git for Windows prints')
  assert.equal(wsl.toMachine('C:\\Users\\dev\\My Project'), '/mnt/c/Users/dev/My Project')
  assert.equal(wsl.toMachine('\\\\wsl.localhost\\Debian\\home'), null, "another distribution's is not its own")
  assert.equal(wsl.toMachine('\\\\fileserver\\share'), null)
  assert.equal(wsl.toMachine('/home/dev'), null)
  assert.equal(wsl.fromMachine('/home/dev/repo'), '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo')
  assert.equal(wsl.fromMachine('/mnt/d/work'), 'D:\\work')
  assert.equal(wsl.guesses, true)

  // Its own drive mount root, as its Studio says it.
  const rooted = machineSpellingOf('wsl:Ubuntu', () => '/win/')!
  assert.equal(rooted.toMachine('C:\\code'), '/win/c/code')
  assert.equal(rooted.fromMachine('/win/c/code'), 'C:\\code')
  // A distribution that mounts no drives: a drive path is not one of its paths.
  assert.equal(machineSpellingOf('wsl:Ubuntu', () => null)!.toMachine('C:\\code'), null)
})

test("a person's words go to a WSL distribution as written; an SSH machine's paths are respelled anywhere", () => {
  const wsl = machineSpellingOf('wsl:Ubuntu')!
  const sent = machinePathsIn(wsl, {
    key: { workspaceRoot: 'C:\\code\\repo' },
    text: 'C:\\code\\repo',
    mentions: [{ path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\a.ts', name: 'C:\\x' }],
  })
  assert.deepEqual(sent, {
    key: { workspaceRoot: '/mnt/c/code/repo' },
    text: 'C:\\code\\repo',
    mentions: [{ path: '/home/dev/a.ts', name: 'C:\\x' }],
  })
  const ssh = machineSpellingOf('ssh:box-1')!
  assert.deepEqual(machinePathsIn(ssh, { text: 'ssh://box-1/home/dev' }), { text: '/home/dev' })
  assert.deepEqual(machinePathsOut(wsl, { workspaceRoot: '/home/dev', note: '/home/dev' }), {
    workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    note: '/home/dev',
  })
  assert.deepEqual(machinePanePathsIn(wsl, { path: 'C:\\a b\\c.ts', content: 'C:\\a b' }), {
    path: '/mnt/c/a b/c.ts',
    content: 'C:\\a b',
  })
})

test('the machine a path is on: an SSH machine, a WSL share; a drive is this computer', () => {
  assert.equal(machineRouteOfPath('ssh://box-1/home/dev'), 'ssh:box-1')
  assert.equal(machineRouteOfPath('ssh://'), undefined)
  assert.equal(machineRouteOfPath('\\\\wsl$\\Ubuntu\\home'), 'wsl:Ubuntu')
  assert.equal(machineRouteOfPath('C:\\code'), null)
  assert.equal(machineRouteOfPath('/Users/dev'), null)
  assert.equal(machineSpellingOf('local'), null)
  assert.equal(machineSpellingOf('tailnet:pair-1'), null)
})

test("a chat's record says where it is: its environment, else on Windows a WSL workspace's machine", () => {
  assert.equal(environmentRouteOfRecord({ environment: { kind: 'ssh', id: 'box-1' } }, 'darwin'), 'ssh:box-1')
  assert.equal(environmentRouteOfRecord({ environment: { kind: 'wsl', id: 'Ubuntu' } }, 'win32'), 'wsl:Ubuntu')
  assert.equal(environmentRouteOfRecord({ hostId: 'wsl:Ubuntu', folderPath: 'C:\\code' }, 'win32'), 'wsl:Ubuntu')
  assert.equal(environmentRouteOfRecord({ folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev' }, 'win32'), 'wsl:Ubuntu')
  // Picked to run on This PC (decision R88).
  assert.equal(environmentRouteOfRecord({ hostId: 'local', folderPath: '\\\\wsl.localhost\\Ubuntu\\x' }, 'win32'), null)
  // Off Windows a `wsl:` id names nothing.
  assert.equal(environmentRouteOfRecord({ hostId: 'wsl:Ubuntu', folderPath: '/Users/dev' }, 'darwin'), null)
  assert.equal(environmentRouteOfRecord({ folderPath: 'C:\\code' }, 'win32'), null)
})
