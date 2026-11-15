// A container as a machine, for real (docs/design/container-chats.md):
// Docker on this computer asked in words, New container made from a
// Dockerfile built on first use, Studio's server installed in it and reached
// over `docker exec` (the SSH machines' install and relay, another exec
// channel), its home a volume of its own, what deleting it would lose read
// from inside, and only Studio's own removed, volume and all.
//
// Runs with STUDIO_TEST_DOCKER=1 and a Docker that answers. The image is a
// light stand-in for Studio's (no agent CLIs), built here; the Node archive is
// cached in STUDIO_TEST_CACHE (or the system temp directory).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { CONTAINER_LABEL } from '../../../shared/containers'
import { SshEnvironments } from '../ssh/ssh-environments'
import { ContainerMachines } from './container-machines'

const DOCKER_TESTS = process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info']).status === 0
const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const CACHE = process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache')
const DOCKERFILE = readFileSync(join(__dirname, '__fixtures__', 'container-test.Dockerfile'), 'utf8')
const IMAGE = {
  tag: `sprintengine-studio-agent:${createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 12)}`,
  dockerfile: DOCKERFILE,
  agents: [],
  refused: [],
}
// The same stand-in under another tag: what a changed set of agents builds.
const NEXT_IMAGE = { ...IMAGE, tag: `${IMAGE.tag.slice(0, -4)}beef`, dockerfile: `${DOCKERFILE}# next\n` }
let image = IMAGE
// A logins volume of this suite's own: Studio's real one on this Docker is never touched.
const LOGINS = `sprintengine-logins-suite-${randomBytes(4).toString('hex')}`

let scratch = ''
const made: string[] = []

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
  for (const name of made) {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    spawnSync('docker', ['volume', 'rm', `${name}-home`], { stdio: 'ignore' })
  }
  // The stand-in image is this suite's own: removed with it. Studio's real image is never touched here.
  if (DOCKER_TESTS)
    for (const tag of [IMAGE.tag, NEXT_IMAGE.tag]) spawnSync('docker', ['image', 'rm', tag], { stdio: 'ignore' })
  if (DOCKER_TESTS) spawnSync('docker', ['volume', 'rm', LOGINS], { stdio: 'ignore' })
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
  const containers = new ContainerMachines({
    machines,
    image: async () => image,
    hostLabel: (host) => (host.kind === 'local' ? 'this Mac' : host.machine),
    loginsVolume: LOGINS,
  })
  return { machines, containers, changes }
}

test.skipIf(!DOCKER_TESTS)(
  'New container: made, reached over docker exec, its home kept on a volume, and deleted with what it would lose said first',
  async () => {
    const { machines, containers } = setup('made')
    const status = await containers.status({ kind: 'local' })
    assert.equal(status.state, 'ready', status.words)
    assert.match(status.words, /^Docker \S+ is running on this Mac/u)

    const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
    assert.ok(created.ok, created.ok ? '' : created.message)
    assert.equal(created.folder, null)
    const saved = machines.get(created.id)!
    const name = saved.container!.name
    made.push(name)
    assert.equal(saved.label, 'sandbox')
    assert.equal(saved.container!.provisioning, false)
    assert.equal(docker('inspect', '-f', `{{index .Config.Labels "${CONTAINER_LABEL}"}}`, name), '1')
    // Two mounts: its own home, a volume Studio labelled, and the host's logins. No folder of the host's.
    assert.deepEqual(
      docker('inspect', '-f', '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}\n{{end}}', name)
        .split('\n')
        .filter(Boolean)
        .sort(),
      [`volume ${LOGINS} /studio-logins`, `volume ${name}-home /home/node`].sort(),
    )
    // Each CLI is pointed into the logins, and a CLI that keeps its login in the home is linked there.
    const env = docker('exec', '-u', 'node', name, 'sh', '-c', 'env')
    assert.match(env, /^CLAUDE_CONFIG_DIR=\/studio-logins\/claude$/mu)
    assert.match(env, /^XDG_CONFIG_HOME=\/studio-logins\/config$/mu)
    assert.equal(docker('exec', '-u', 'node', name, 'readlink', '/home/node/.kimi-code'), '/studio-logins/kimi-code')
    assert.equal(docker('volume', 'inspect', '-f', `{{index .Labels "${CONTAINER_LABEL}"}}`, `${name}-home`), '1')
    // No capability, and no way to gain one.
    assert.equal(docker('inspect', '-f', '{{json .HostConfig.CapDrop}}', name), '["ALL"]')
    assert.match(docker('inspect', '-f', '{{json .HostConfig.SecurityOpt}}', name), /no-new-privileges/u)

    // Studio's own server runs inside, reached as a machine over `docker exec`.
    const connection = machines.connection(created.id)
    assert.ok(connection, 'connected after create')
    assert.equal(connection.owner.welcome.environment.hostKind, 'ssh')
    assert.ok((await connection.owner.request('conversation.list', {})).conversations)
    assert.equal(machines.list().find((entry) => entry.id === created.id)?.stateText, 'Connected')
    // No credential of the host's is there.
    assert.doesNotMatch(env, /^(CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|SSH_AUTH_SOCK)=/mu)

    // A repository inside, with one branch pushed and one not.
    const inside = (command: string) => docker('exec', '-u', 'node', '-w', '/home/node', name, 'sh', '-c', command)
    inside(
      [
        'git init -q --bare -b main origin.git',
        'git clone -q origin.git work/app 2>/dev/null',
        'cd work/app',
        'git -c user.name=Dev -c user.email=dev@example.com commit -q --allow-empty -m first',
        'git push -q origin main',
        'git checkout -q -b agent/fix',
        'git -c user.name=Dev -c user.email=dev@example.com commit -q --allow-empty -m fix',
      ].join(' && '),
    )
    const unpushed = await containers.unpushed(created.id)
    assert.deepEqual(unpushed, {
      ok: true,
      branches: [{ repo: '/home/node/work/app', branch: 'agent/fix', commits: 1 }],
      dirty: [],
      detached: [],
      stashes: [],
      chatsRunning: 0,
    })
    // Made again on a new image (the agents set up in Studio changed): its repositories and the logins stay.
    const marker = `.suite-${randomBytes(4).toString('hex')}`
    docker('exec', '-u', 'node', name, 'sh', '-c', `echo kept > /studio-logins/${marker}`)
    image = NEXT_IMAGE
    try {
      const rebuilt = await containers.rebuild(created.id)
      assert.ok(rebuilt.ok, rebuilt.ok ? '' : rebuilt.message)
    } finally {
      image = IMAGE
    }
    assert.equal(docker('inspect', '-f', '{{.Config.Image}}', name), NEXT_IMAGE.tag)
    assert.equal(machines.get(created.id)?.container?.image, NEXT_IMAGE.tag)
    assert.equal(docker('exec', '-u', 'node', name, 'cat', `/studio-logins/${marker}`), 'kept')
    docker('exec', '-u', 'node', name, 'rm', '-f', `/studio-logins/${marker}`)
    assert.equal(inside('git -C work/app log --format=%s agent/fix'), 'fix\nfirst')
    assert.ok(machines.connection(created.id), 'its server is reached again')

    // A clone never lands over a folder already there.
    const over = await containers.clone(created.id, 'acme/app')
    assert.equal(over.ok, false)
    assert.match(over.ok ? '' : over.message, /\/home\/node\/work\/app is already there/u)

    // Docker stopped it (Colima stopped overnight): the next connect starts it again, the repository kept.
    machines.disconnect(created.id)
    docker('stop', '-t', '1', name)
    const back = await machines.connect(created.id)
    assert.ok(back.ok, `reached again after a stop: ${back.ok ? '' : back.message}`)
    assert.equal(inside('git -C work/app log --format=%s agent/fix'), 'fix\nfirst')

    // Deleting: Studio's own only, its home volume with it.
    const foreign = 'sprintengine-fedcba9876543210'
    docker('run', '-d', '--name', foreign, IMAGE.tag)
    made.push(foreign)
    assert.ok((await machines.forget(created.id)).ok)
    assert.equal(spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status, 1, 'gone from Docker')
    assert.equal(spawnSync('docker', ['volume', 'inspect', `${name}-home`], { stdio: 'ignore' }).status, 1)
    assert.equal(machines.get(created.id), null, 'gone from the saved machines')
    assert.equal(
      docker('inspect', '-f', '{{.State.Running}}', foreign),
      'true',
      'a container without the label is left',
    )
    machines.shutdown()
  },
  15 * 60_000,
)
