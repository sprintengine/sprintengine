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
  })
  const chats = new ContainerChats({
    machines,
    image: () => IMAGE,
    hostLabel: (host) => (host.kind === 'local' ? 'this Mac' : host.machine),
    onChange: () => changes.push('containers'),
  })
  return { machines, chats, changes }
}

/** A project with one commit, whose `origin` is a bare repository beside it. */
function project(): { folder: string; origin: string } {
  const origin = join(scratch, 'origin.git')
  const folder = join(scratch, 'demo app')
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

    // Studio's own server runs inside, reached as a machine over `docker exec`.
    const connection = machines.connection(created.id)
    assert.ok(connection, 'connected after create')
    assert.equal(connection.owner.welcome.environment.hostKind, 'ssh')
    assert.ok((await connection.owner.request('conversation.list', {})).conversations)
    assert.equal(machines.list().find((entry) => entry.id === created.id)?.stateText, 'Connected')

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
    const listed = await chats.list()
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
