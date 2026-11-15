import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, test } from 'vitest'

import {
  agentEnv,
  agentEnvPairs,
  agentFacingDirectory,
  agentGatewayDirectory,
  agentReadableFileMode,
  agentSharedFolder,
  assertAgentTerritory,
  lookUpAgentUser,
  passwdEntry,
  resetAgentUserForTests,
  shareTreeWithAgent,
  type AgentUser,
} from './agent-user'

const AGENT: AgentUser = { uid: 1000, gid: 1000, name: 'node', home: '/home/node' }
const SERVER = { home: '/root', name: 'root' }
const POSIX = process.platform !== 'win32'

afterEach(() => resetAgentUserForTests())

test("the agent's user is read from passwd by its uid, never root, and a machine without it refuses in words", () => {
  const passwd =
    'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/sh\nnode2:x:10000:10000::/home/n2:/bin/sh\n'
  assert.deepEqual(passwdEntry(passwd, 1000), { name: 'node', home: '/home/node' })
  assert.equal(passwdEntry(passwd, 100), null)
  const dir = mkdtempSync(join(tmpdir(), 'se-passwd-'))
  try {
    writeFileSync(join(dir, 'passwd'), passwd)
    assert.deepEqual(lookUpAgentUser(1000, 1000, join(dir, 'passwd')), AGENT)
    assert.throws(() => lookUpAgentUser(0, 0, join(dir, 'passwd')), /never root/u)
    assert.throws(() => lookUpAgentUser(1001, 1001, join(dir, 'passwd')), /no user 1001/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a child's environment is the agent's: its home and names where the server's were, a home chosen on purpose kept", () => {
  assert.deepEqual(
    agentEnv({ HOME: '/root', USER: 'root', PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' }, AGENT, SERVER),
    {
      HOME: '/home/node',
      USER: 'node',
      LOGNAME: 'node',
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
    },
  )
  assert.equal(agentEnv({ HOME: '/home/node/.isolated' }, AGENT, SERVER).HOME, '/home/node/.isolated')
  assert.deepEqual(agentEnvPairs(['HOME=/root', 'A=b=c'], AGENT, SERVER).sort(), [
    'A=b=c',
    'HOME=/home/node',
    'LOGNAME=node',
    'USER=node',
  ])
})

test.skipIf(!POSIX)(
  'once the server becomes the agent server, every way of starting a program is the agent’s, a function taken before too',
  () => {
    // In a process of its own: the hooks are for the rest of a process's life.
    const dir = mkdtempSync(join(tmpdir(), 'se-agent-hooks-'))
    try {
      const bundle = join(dir, 'agent-user.cjs')
      buildSync({
        entryPoints: [join(__dirname, 'agent-user.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent',
      })
      const probe = join(dir, 'probe.cjs')
      writeFileSync(
        probe,
        `
const { spawn: takenBefore, execFile, execFileSync: syncTakenBefore } = require('node:child_process')
const cp = require('node:child_process')
const { startProgramsAsAgent } = require(${JSON.stringify(bundle)})
const user = { uid: process.getuid(), gid: process.getgid(), name: 'agent-probe', home: ${JSON.stringify(join(dir, 'home'))} }
startProgramsAsAgent(user)
const say = 'printf "%s %s %s" "$HOME" "$USER" "$(id -u)"'
const out = {}
out.execFileSync = cp.execFileSync('sh', ['-c', say]).toString()
out.execSync = cp.execSync(say).toString()
out.spawnSync = cp.spawnSync('sh', ['-c', say]).stdout.toString()
out.syncTakenBefore = syncTakenBefore('sh', ['-c', say]).toString()
const child = takenBefore('sh', ['-c', say])
let spawned = ''
child.stdout.on('data', (d) => (spawned += d))
child.on('close', () => {
  out.spawnTakenBefore = spawned
  execFile('sh', ['-c', say], (error, stdout) => {
    out.execFile = stdout
    process.stdout.write(JSON.stringify(out))
  })
})
`,
      )
      const said = JSON.parse(execFileSync(process.execPath, [probe], { encoding: 'utf8' })) as Record<string, string>
      const expected = `${join(dir, 'home')} agent-probe ${process.getuid!()}`
      for (const [how, text] of Object.entries(said)) assert.equal(text, expected, how)
      assert.deepEqual(Object.keys(said).sort(), [
        'execFile',
        'execFileSync',
        'execSync',
        'spawnSync',
        'spawnTakenBefore',
        'syncTakenBefore',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test.skipIf(!POSIX)(
  "what the server shares with its agents: a folder of its own the agent's group may read, refused when someone else made it",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'se-agent-shared-'))
    try {
      // Outside the mode nothing moves: the data directory is the gateway's, and files are the owner's.
      assert.equal(agentGatewayDirectory(join(dir, 'data')), join(dir, 'data'))
      assert.equal(agentFacingDirectory(join(dir, 'data'), 'uploads'), join(dir, 'data', 'uploads'))
      assert.equal(agentSharedFolder('x'), null)
      assert.equal(agentReadableFileMode(), 0o600)

      // The group a folder made here gets (macOS gives it the parent's).
      const me: AgentUser = { uid: 4242, gid: lstatSync(dir).gid, name: 'node', home: join(dir, 'home') }
      resetAgentUserForTests(me, join(dir, 'lib', 'sprintengine-studio-abc'))
      const shared = agentGatewayDirectory(join(dir, 'data'))
      assert.equal(shared, join(dir, 'lib', 'sprintengine-studio-abc'))
      assert.equal(lstatSync(shared).mode & 0o777, 0o750)
      assert.equal(agentFacingDirectory(join(dir, 'data'), 'uploads'), join(shared, 'uploads'))
      assert.equal(lstatSync(join(shared, 'uploads')).mode & 0o777, 0o750)
      assert.equal(agentReadableFileMode(), 0o640)

      // A staged tree: folders 0750, files 0640, a link left a link.
      const tree = join(dir, 'tree')
      mkdirSync(join(tree, 'skills'), { recursive: true, mode: 0o700 })
      writeFileSync(join(tree, 'skills', 'SKILL.md'), 'x', { mode: 0o600 })
      symlinkSync('/etc/hosts', join(tree, 'link'))
      await shareTreeWithAgent(tree)
      assert.equal(lstatSync(join(tree, 'skills')).mode & 0o777, 0o750)
      assert.equal(lstatSync(join(tree, 'skills', 'SKILL.md')).mode & 0o777, 0o640)
      assert.ok(lstatSync(join(tree, 'link')).isSymbolicLink())

      // A folder in its place that is a link is not used.
      resetAgentUserForTests(me, join(dir, 'lib', 'planted'))
      symlinkSync(join(dir, 'tree'), join(dir, 'lib', 'planted'))
      assert.throws(() => agentSharedFolder(), /not a folder this server made/u)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test.skipIf(!POSIX)("a client's write is held to the agent's home: a link out of it does not carry a save", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-agent-home-')))
  try {
    mkdirSync(join(dir, 'home', 'work'), { recursive: true })
    // Outside the mode, nothing is refused.
    assert.doesNotThrow(() => assertAgentTerritory('/etc'))
    resetAgentUserForTests({ uid: 1000, gid: 1000, name: 'node', home: join(dir, 'home') }, join(dir, 'shared'))
    assert.doesNotThrow(() => assertAgentTerritory(join(dir, 'home', 'work')))
    assert.doesNotThrow(() => assertAgentTerritory(join(dir, 'home')))
    assert.throws(() => assertAgentTerritory('/opt/sprintengine-studio'), /writes only inside/u)
    assert.throws(() => assertAgentTerritory(join(dir, 'home-other')), /writes only inside/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
