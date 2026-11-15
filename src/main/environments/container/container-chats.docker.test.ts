// A chat's container for real (docs/design/container-chats.md): Docker on
// this computer asked in words, a container made from a Dockerfile built on
// first use, Studio's server installed in it and reached over `docker exec`
// (the SSH machines' install and relay, another exec channel), a repository
// copied in as a bundle with no credential, a commit made inside brought out
// and pushed from the host, every container Studio made listed, and only
// Studio's own removed.
//
// Runs with STUDIO_TEST_DOCKER=1 and a Docker that answers. The image is a
// light stand-in for Studio's (no agent CLIs), built here; the Node archive is
// cached in STUDIO_TEST_CACHE (or the system temp directory).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { CONTAINER_LABEL } from '../../../shared/containers'
import { SshEnvironments } from '../ssh/ssh-environments'
import { ContainerChats } from './container-chats'
import { imageFor } from './container-image'

const DOCKER_TESTS = process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info']).status === 0
const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const CACHE = process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache')
const DOCKERFILE = readFileSync(join(__dirname, '__fixtures__', 'container-test.Dockerfile'), 'utf8')
const IMAGE = imageFor(DOCKERFILE)

const AGENT_TOKEN = `sk-ant-oat01-${'standin'.repeat(6)}`
let scratch = ''
const made: string[] = []

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-15T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-15T00:00:00Z' },
  }).trim()
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim()

beforeAll(() => {
  if (!DOCKER_TESTS) return
  scratch = mkdtempSync(join(tmpdir(), 'se-container-'))
  // The app root a development build reads its server tree from (`out/wsl-server`).
  execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', join(scratch, 'app', 'out', 'wsl-server')],
    { cwd: ROOT, stdio: 'pipe' },
  )
}, 10 * 60_000)

afterAll(() => {
  for (const name of made) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  // The stand-in image is this suite's own: removed with it. Studio's real image is never touched here.
  if (DOCKER_TESTS) spawnSync('docker', ['image', 'rm', IMAGE.tag], { stdio: 'ignore' })
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

function setup(profile: string) {
  const userData = join(scratch, profile)
  mkdirSync(userData, { recursive: true })
  mkdirSync(CACHE, { recursive: true })
  try {
    symlinkSync(CACHE, join(userData, 'ssh-runtime'))
  } catch {
    // Linked by an earlier test.
  }
  const changes: string[] = []
  const machines = new SshEnvironments({
    userDataDir: userData,
    app: { version: VERSION, channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: join(scratch, 'app'),
    isDefaultProfile: true,
    startedBy: 'Studio on dev-macbook-air',
    broadcast: (channel) => changes.push(channel),
    // The agent's own login, as Settings keeps it: a stand-in value here.
    containerEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: AGENT_TOKEN }),
  })
  const chats = new ContainerChats({
    machines,
    image: () => IMAGE,
    hostLabel: (host) => (host.kind === 'local' ? 'this Mac' : host.machine),
    onChange: () => changes.push('containers'),
  })
  return { machines, chats, changes }
}

/** Where the container's Studio server keeps its data: root's own home. */
const SERVER_DATA = '/root/.local/share/sprintengine-studio/data'

/** The container's Studio server's pid, from its record (read as root: it is root's). */
function serverPidOf(name: string): string {
  return docker(
    'exec',
    '-u',
    '0',
    name,
    'sh',
    '-c',
    `sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' ${SERVER_DATA}/run/server.json`,
  )
}

/** A command's exit status as the container's `node` user, the agent's: 0 when it was allowed. */
const asAgent = (name: string, command: string) =>
  spawnSync('docker', ['exec', '-u', 'node', name, 'sh', '-c', command], { encoding: 'utf8', timeout: 60_000 })

/** A project with one commit, whose `origin` is a bare repository beside it. */
function project(tag = ''): { folder: string; origin: string } {
  const origin = join(scratch, `origin${tag}.git`)
  const folder = join(scratch, `demo app${tag}`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  mkdirSync(folder, { recursive: true })
  git(folder, 'init', '-q', '-b', 'main')
  git(folder, 'config', 'user.name', 'Dev')
  git(folder, 'config', 'user.email', 'dev@example.com')
  writeFileSync(join(folder, 'README.md'), '# demo\n')
  git(folder, 'add', '.')
  git(folder, 'commit', '-q', '-m', 'first')
  git(folder, 'remote', 'add', 'origin', origin)
  git(folder, 'push', '-q', 'origin', 'main')
  // Uncommitted work stays on the host.
  writeFileSync(join(folder, 'notes.txt'), 'not committed\n')
  return { folder, origin }
}

test.skipIf(!DOCKER_TESTS)(
  'a container for a chat: made, reached over docker exec, repository in, branch out from the host, removed',
  async () => {
    const { machines, chats } = setup('made')
    const status = await chats.status({ kind: 'local' })
    assert.equal(status.state, 'ready', status.words)
    assert.match(status.words, /^Docker \S+ is running on this Mac/u)

    const { folder, origin } = project()
    const created = await chats.create({
      host: { kind: 'local' },
      folder,
      label: 'Fix the login',
      image: { kind: 'studio-default' },
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    const saved = machines.get(created.id)!
    const name = saved.container!.name
    made.push(name)
    assert.equal(created.folder, '/home/node/work/demo-app')
    assert.equal(created.label, 'Fix the login (container)')
    assert.equal(docker('inspect', '-f', `{{index .Config.Labels "${CONTAINER_LABEL}"}}`, name), '1')
    // No folder of the host is mounted into it.
    assert.equal(docker('inspect', '-f', '{{len .Mounts}}', name), '0')
    // No capability but the three its server needs to run agents as another user, and no way to gain one.
    assert.equal(docker('inspect', '-f', '{{json .HostConfig.CapDrop}}', name), '["ALL"]')
    assert.deepEqual(
      (JSON.parse(docker('inspect', '-f', '{{json .HostConfig.CapAdd}}', name)) as string[])
        .map((each) => each.replace(/^CAP_/u, ''))
        .sort(),
      ['KILL', 'SETGID', 'SETUID'],
    )
    assert.match(docker('inspect', '-f', '{{json .HostConfig.SecurityOpt}}', name), /no-new-privileges/u)

    // Studio's own server runs inside, reached as a machine over `docker exec`.
    const connection = machines.connection(created.id)
    assert.ok(connection, 'connected after create')
    assert.equal(connection.owner.welcome.environment.hostKind, 'ssh')
    assert.ok((await connection.owner.request('conversation.list', {})).conversations)
    assert.equal(machines.list().find((entry) => entry.id === created.id)?.stateText, 'Connected')

    // The agent's login reached the server it runs under, and nowhere Docker keeps: not the
    // container's saved config, not a command line. No git credential is there.
    // (The server's own environment is no process's to read: it is root's, and it stopped being dumpable
    // when it took the agent's group. What it hands an agent is read from the agent's, in the test below.)
    assert.ok(!docker('inspect', '-f', '{{json .Config.Env}}', name).includes(AGENT_TOKEN), 'not in its saved config')
    assert.ok(!docker('exec', name, 'ps', '-eo', 'args').includes(AGENT_TOKEN), 'not in a command line')

    // The repository: its commit, on the chat's own branch, origin the host's address, nothing uncommitted.
    const inside = (command: string) => docker('exec', '-u', 'node', '-w', created.folder, name, 'sh', '-c', command)
    assert.equal(inside('git log --format=%s'), 'first')
    assert.equal(inside('git symbolic-ref --short HEAD'), saved.container!.repo?.branch ?? 'none')
    assert.match(saved.container!.repo!.branch, /^studio\/container-[a-f0-9]{8}$/u)
    assert.equal(saved.container!.repo!.base, 'main')
    assert.equal(inside('git remote get-url origin'), origin)
    assert.equal(inside('test -e notes.txt && echo here || echo absent'), 'absent')
    assert.equal(inside('git config user.email'), 'dev@example.com')

    // An agent's commit leaves only as the branch, pushed from the host.
    inside("echo 'fixed' > fix.txt && git add fix.txt && git commit -q -m 'fix the login'")
    const pushed = await chats.push(created.id)
    assert.ok(pushed.ok, pushed.ok ? '' : pushed.message)
    const branch = saved.container!.repo!.branch
    assert.equal(git(origin, 'log', '--format=%s', branch), 'fix the login\nfirst')
    // The person's own branches and working tree are untouched.
    assert.equal(git(folder, 'branch', '--format=%(refname:short)'), 'main')
    assert.equal(git(folder, 'status', '--porcelain'), '?? notes.txt')

    // Listed, and a container Docker has with Studio's label but no record here is listed too.
    const stray = 'sprintengine-0123456789abcdef'
    docker('run', '-d', '--name', stray, '--label', `${CONTAINER_LABEL}=1`, IMAGE.tag)
    made.push(stray)
    // (Containers another Studio profile on this Docker made are listed too; only this suite's are compared.)
    const listed = (await chats.list()).filter((entry) => made.includes(entry.name))
    assert.deepEqual(
      listed.map((entry) => [entry.id, entry.name]).sort(),
      [
        [created.id, name],
        [null, stray],
      ].sort(),
    )

    // Removing: Studio's own only.
    const foreign = 'sprintengine-fedcba9876543210'
    docker('run', '-d', '--name', foreign, IMAGE.tag)
    made.push(foreign)
    const refused = await chats.remove({ host: { kind: 'local' }, name: foreign })
    assert.equal(refused.ok, false)
    assert.equal(
      docker('inspect', '-f', '{{.State.Running}}', foreign),
      'true',
      'a container without the label is left',
    )
    assert.ok((await chats.remove({ host: { kind: 'local' }, name: stray })).ok)
    assert.ok((await chats.remove({ id: created.id })).ok)
    assert.equal(spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status, 1, 'gone from Docker')
    assert.equal(machines.get(created.id), null, 'gone from the saved machines')
    machines.shutdown()
  },
  15 * 60_000,
)

test.skipIf(!DOCKER_TESTS)(
  'a folder that is not a repository leaves no container behind',
  async () => {
    const { machines, chats } = setup('refused')
    const plain = join(scratch, 'plain')
    mkdirSync(plain, { recursive: true })
    const before = docker('ps', '-a', '-q', '--filter', `label=${CONTAINER_LABEL}=1`)
    const created = await chats.create({
      host: { kind: 'local' },
      folder: plain,
      label: 'x',
      image: { kind: 'studio-default' },
    })
    assert.equal(created.ok, false)
    assert.match(created.ok ? '' : created.message, /is not a git repository/u)
    assert.equal(docker('ps', '-a', '-q', '--filter', `label=${CONTAINER_LABEL}=1`), before)
    assert.equal(machines.list().filter((entry) => entry.container).length, 0)
    machines.shutdown()
  },
  10 * 60_000,
)

test.skipIf(!DOCKER_TESTS)(
  "the container's Studio server and its agent are separate users: the agent cannot reach the server, and runs as node",
  async () => {
    const { machines, chats } = setup('users')
    const { folder } = project('-users')
    const created = await chats.create({
      host: { kind: 'local' },
      folder,
      label: 'Two users',
      image: { kind: 'studio-default' },
    })
    assert.ok(created.ok, created.ok ? '' : created.message)
    const name = machines.get(created.id)!.container!.name
    made.push(name)
    assert.equal(machines.get(created.id)!.container!.separateUsers, true)
    const connection = machines.connection(created.id)!
    assert.ok(connection, 'connected after create')

    // The server: root, in the agent's group, holding only the three capabilities.
    const serverPid = serverPidOf(name)
    assert.match(serverPid, /^\d+$/u)
    const status = docker('exec', '-u', '0', name, 'cat', `/proc/${serverPid}/status`)
    assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/mu)
    assert.match(status, /^Gid:\s+1000\s+1000\s+1000\s+1000$/mu)
    assert.match(status, /^CapEff:\s+00000000000000e0$/mu)
    assert.match(status, /^NoNewPrivs:\s+1$/mu)
    // Its tree is in /opt, root's and readable; its data in root's home.
    assert.match(
      docker('exec', '-u', '0', name, 'sh', '-c', `tr '\\0' ' ' < /proc/${serverPid}/cmdline`),
      /^\/opt\/sprintengine-studio\//u,
    )

    // The agent's user: no capability, and none of the server's.
    assert.match(asAgent(name, 'grep CapEff /proc/self/status').stdout, /CapEff:\s+0{16}/u)
    assert.notEqual(
      asAgent(name, `cat ${SERVER_DATA}/run/owner-token`).status,
      0,
      'the owner token is not the agent’s to read',
    )
    assert.notEqual(asAgent(name, 'ls /root').status, 0, "root's home is closed to it")
    assert.notEqual(asAgent(name, `kill -0 ${serverPid}`).status, 0, 'it cannot signal the server')
    assert.notEqual(asAgent(name, `grep . /proc/${serverPid}/environ`).status, 0, "nor read the server's environment")
    assert.notEqual(asAgent(name, 'touch /opt/sprintengine-studio/planted').status, 0, "nor change the server's tree")
    assert.equal(asAgent(name, 'test -r /opt/sprintengine-studio/server-*/bridge.mjs').status, 0, 'which it may read')

    // The gateway is the agent's to reach (its MCP bridge runs as it, with the server's Node), and not to replace.
    const gateway = docker('exec', '-u', '0', name, 'sh', '-c', 'ls -d /var/lib/sprintengine-studio-*')
    assert.match(asAgent(name, `cat ${gateway}/sprintengine-studio-mcp-info.json`).stdout, /"socketPath"/u)
    const reach = asAgent(
      name,
      `/opt/sprintengine-studio/runtime/node-*/bin/node -e "require('net').connect('${gateway}/automation.sock').on('connect', () => process.exit(0)).on('error', (e) => { console.log(e.code); process.exit(1) })"`,
    )
    assert.equal(reach.status, 0, reach.stdout + reach.stderr)
    assert.notEqual(asAgent(name, `rm -f ${gateway}/automation.sock`).status, 0)
    assert.notEqual(asAgent(name, `touch ${gateway}/planted`).status, 0)

    // A program the server runs in the agent's repository runs as the agent: git's clean filter, which a
    // repository's own configuration names, during the Git pane's status (a file whose time changed and
    // whose size did not is read through it).
    const repo = created.folder
    const ran = '/home/node/filter-ran-as'
    const inRepo = (command: string) => docker('exec', '-u', 'node', '-w', repo, name, 'sh', '-c', command)
    inRepo(
      `git config filter.probe.clean 'sh -c "id -u > ${ran}; cat"' && echo 'README.md filter=probe' > .gitattributes`,
    )
    // The pane's status is kept and refreshed as the folder changes: the time is moved once that has settled,
    // and the status asked again until git has read the file through the filter.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    inRepo('touch -m -d @1 README.md')
    let filtered = ''
    for (let tries = 0; tries < 40 && !filtered; tries++) {
      assert.ok(await connection.owner.request('git.status', { repoRoot: repo }), 'the Git pane read the repository')
      // Read as node: the agent's home is its group's, and root here holds no capability past that.
      filtered = asAgent(name, `cat ${ran}`).stdout.trim()
      if (!filtered) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.equal(filtered, '1000', 'git ran as node, not as the server')

    // A link the agent put in its repository does not carry a save onto a root-owned file.
    const motd = docker('exec', '-u', '0', name, 'sh', '-c', 'cat /etc/motd 2>/dev/null; stat -c %U /etc/motd')
    inRepo('ln -s /etc etc-link && ln -s /etc/motd motd-link')
    for (const path of [`${repo}/etc-link/motd`, `${repo}/motd-link`]) {
      await assert.rejects(
        connection.owner.request('files.writeText', { commandId: `save-${path}`, path, text: 'written by a link' }),
        // Refused (the reason is in the server's log; a client is told only that it was not carried out).
        (error: Error) => error.name === 'StudioError',
        path,
      )
    }
    assert.equal(docker('exec', '-u', '0', name, 'sh', '-c', 'cat /etc/motd 2>/dev/null; stat -c %U /etc/motd'), motd)
    // A save in the repository itself is the person's, and the agent's to change after.
    await connection.owner.request('files.writeText', {
      commandId: 'save-notes',
      path: `${repo}/NOTES.md`,
      text: 'hi\n',
    })
    assert.equal(inRepo('echo agent >> NOTES.md && cat NOTES.md'), 'hi\nagent')

    // An agent CLI a chat starts runs as node, in the agent's home: the OpenCode stand-in, run with the
    // server's Node (the stand-in image has none of its own).
    // Written by root through stdin (a `docker cp` keeps the host's owner, which root here may not change).
    execFileSync('docker', ['exec', '-i', '-u', '0', name, 'sh', '-c', 'cat > /usr/local/lib/opencode-standin.js'], {
      input: readFileSync(join(ROOT, 'tests', 'docker', 'bin', 'opencode')),
    })
    docker(
      'exec',
      '-u',
      '0',
      name,
      'sh',
      '-c',
      `printf '#!/bin/sh\\nexec $(ls -d /opt/sprintengine-studio/runtime/node-*/bin/node | head -n 1) /usr/local/lib/opencode-standin.js "$@"\\n' > /usr/local/bin/opencode && chmod 755 /usr/local/bin/opencode && chmod 644 /usr/local/lib/opencode-standin.js`,
    )
    const chat = await connection.owner.request('conversation.create', {
      commandId: 'two-users-chat',
      noProject: true,
      cli: 'opencode',
      prompt: '!slow',
    })
    assert.ok(chat, 'a chat started')
    let agents = ''
    for (let tries = 0; tries < 60 && !/opencode-standin/u.test(agents); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      agents = docker('exec', '-u', '0', name, 'ps', '-eo', 'uid=,args=')
    }
    const standin = agents.split('\n').find((line) => line.includes('opencode-standin'))
    assert.ok(standin, `the stand-in agent started:\n${agents}`)
    assert.match(standin!, /^\s*1000\s/u, 'as node')
    const agentPid = docker('exec', '-u', '0', name, 'pgrep', '-f', 'opencode-standin').split('\n')[0]
    // Read as node: the agent's process is node's, and root here holds no capability to read another's.
    const agentEnv = asAgent(name, `tr '\\0' '\\n' < /proc/${agentPid}/environ`).stdout
    assert.match(agentEnv, /^HOME=\/home\/node$/mu)
    assert.match(agentEnv, /^USER=node$/mu)
    // The agent's login reached it through the server, and no git credential did.
    assert.ok(agentEnv.split('\n').includes(`CLAUDE_CODE_OAUTH_TOKEN=${AGENT_TOKEN}`), 'the agent holds its login')
    assert.doesNotMatch(agentEnv, /^(GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|SSH_AUTH_SOCK)=/mu)
    assert.match(asAgent(name, `readlink /proc/${agentPid}/cwd`).stdout.trim(), /^\/home\/node\//u)

    assert.ok((await chats.remove({ id: created.id })).ok)
    machines.shutdown()
  },
  15 * 60_000,
)
