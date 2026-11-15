import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SavedSshEnvironment } from '../../../shared/ssh-environments'
import { SshEnvironments } from '../ssh/ssh-environments'
import { ContainerMachines } from './container-machines'
import { localHostRunner } from './docker-host'

// Containers as saved machines, with a stand-in `docker` on this computer:
// what is kept when Docker cannot answer, what a forgotten SSH machine does
// to the containers on it, and what a making cut short leaves.

const scratch = mkdtempSync(join(tmpdir(), 'se-container-machines-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const BASE = join(scratch, 'base')
mkdirSync(BASE, { recursive: true })
for (const tool of ['sed', 'cat', 'sleep']) {
  const found = ['/usr/bin', '/bin']
    .map((dir) => join(dir, tool))
    .find((path) => {
      try {
        execFileSync('test', ['-x', path])
        return true
      } catch {
        return false
      }
    })
  if (found) symlinkSync(found, join(BASE, tool))
}

let made = 0
const STAND_IN_IMAGE = {
  tag: 'sprintengine-studio-agent:0123456789ab',
  dockerfile: 'FROM scratch\n',
  agents: [],
  refused: [],
}
function setup(docker: string, saved: SavedSshEnvironment[] = [], extra: Record<string, unknown> = {}) {
  const dir = join(scratch, `case-${made++}`)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${docker}\n`)
  chmodSync(join(bin, 'docker'), 0o755)
  if (saved.length) writeFileSync(join(dir, 'ssh-environments.json'), JSON.stringify({ v: 1, environments: saved }))
  const machines = new SshEnvironments({
    userDataDir: dir,
    app: { version: '0.0.0', channel: 'latest' },
    packaged: false,
    resourcesDir: null,
    appRoot: null,
    isDefaultProfile: true,
    startedBy: 'Studio on dev-macbook-air',
    broadcast: () => undefined,
    localRunner: localHostRunner({ env: { PATH: `${bin}:${BASE}`, HOME: dir }, searchPath: false }),
    ...extra,
  })
  return { machines, dir }
}

const container = (id: string, host: SavedSshEnvironment['container'] extends infer C ? C : never) =>
  ({
    id,
    label: `${id} (container)`,
    destination: `sprintengine-${id}`,
    resolved: null,
    environmentId: null,
    settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true },
    addedAt: 0,
    container: host,
  }) as SavedSshEnvironment

const localContainer = (id: string) =>
  container(id, {
    host: { kind: 'local' },
    name: `sprintengine-${id}`,
    image: 'sprintengine-studio-agent:0123456789ab',
    createdAt: 0,
  })

test('a container is not forgotten while Docker cannot say it is gone: its record stays, and the words say why', async () => {
  const { machines } = setup('exit 1', [localContainer('0123456789abcdef')])
  const forgotten = await machines.forget('0123456789abcdef')
  assert.equal(forgotten.ok, false)
  assert.match(
    forgotten.ok ? '' : forgotten.message,
    /Docker is not running on this computer, so sprintengine-0123456789abcdef is still there/u,
  )
  assert.ok(machines.get('0123456789abcdef'), 'the record is kept')
  assert.match(
    forgotten.ok ? '' : forgotten.message,
    /Delete it again once Docker answers there, or forget only its record/u,
  )
  // Docker gone for good: the person forgets only the record, and nothing is asked of Docker.
  const dropped = await machines.forget('0123456789abcdef', { recordOnly: true })
  assert.equal(dropped.ok, true)
  assert.equal(machines.get('0123456789abcdef'), null)
  machines.shutdown()
})

test('an SSH machine with containers on it is not forgotten silently; its records only, when it is gone', async () => {
  const ssh: SavedSshEnvironment = {
    id: 'aaaaaaaaaaaaaaaa',
    label: 'build-box',
    destination: 'build-box',
    resolved: null,
    environmentId: null,
    settings: { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS },
    addedAt: 0,
  }
  const onIt = container('0123456789abcdef', {
    host: { kind: 'ssh', machine: 'aaaaaaaaaaaaaaaa' },
    name: 'sprintengine-0123456789abcdef',
    image: 'sprintengine-studio-agent:0123456789ab',
    createdAt: 0,
  })
  const { machines } = setup('exit 1', [ssh, onIt])
  const refused = await machines.forget('aaaaaaaaaaaaaaaa')
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.containers, ['0123456789abcdef'])
  assert.match(
    refused.ok ? '' : refused.message,
    /build-box has a container Studio made \(0123456789abcdef \(container\)\)\. Delete it first/u,
  )
  assert.ok(machines.get('aaaaaaaaaaaaaaaa') && machines.get('0123456789abcdef'), 'both still saved')
  const dropped = await machines.forget('aaaaaaaaaaaaaaaa', { containers: 'forget-records' })
  assert.equal(dropped.ok, true)
  assert.equal(machines.get('aaaaaaaaaaaaaaaa'), null)
  assert.equal(machines.get('0123456789abcdef'), null)
  machines.shutdown()
})

test('a container is saved before Docker is asked to start it; one whose start did not answer stays listed', async () => {
  const { machines } = setup(
    [
      'case "$1" in',
      '  version) echo 29.2.1 ;;',
      '  context) echo colima ;;',
      '  image) exit 0 ;;',
      // Docker is asked to start it and does not answer. Asked about it, it has no
      // such container yet: the record is kept anyway, since its own command may still make it.
      '  --context) case "$3" in volume) exit 0 ;; run) sleep 5 ;; version) echo 29 ;; inspect) echo "Error: No such object: x" >&2; exit 1 ;; esac ;;',
      'esac',
    ].join('\n'),
  )
  const containers = new ContainerMachines({
    machines,
    image: async () => STAND_IN_IMAGE,
    hostLabel: () => 'this Mac',
    timing: { runMs: 300 },
  })
  const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
  assert.equal(created.ok, false)
  assert.match(
    created.ok ? '' : created.message,
    /The container may have been started; it is listed in Settings › Machines, where it can be deleted/u,
  )
  const kept = machines.list().filter((entry) => entry.container)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.label, 'sandbox')
  assert.equal(kept[0]!.container!.provisioning, true)
  assert.equal(kept[0]!.container!.context, 'colima', 'kept on the context it was made under')
  // Its row says its making was cut short, in words, with nothing to connect.
  assert.equal(kept[0]!.stateText, 'Its making was cut short. Delete it, and make it again.')
  assert.equal(kept[0]!.action, null)
  machines.shutdown()
})

/** A stand-in `docker` under the Colima context that logs every call, its answers set per case. */
function loggingDocker(answers: {
  image: string
  build: string
  exec: string
  /** The image asked for under the Colima context (a container's own); present unless said. */
  contextImage?: string
  run?: string
  /** The logins readied, as the agent's user (`exec -u`); `exec` answers it unless said. */
  prepare?: string
}): string {
  return [
    'echo "$*" >> "$HOME/calls"',
    'case "$1" in',
    '  version) echo 29.2.1 ;;',
    '  context) echo colima ;;',
    `  image) ${answers.image} ;;`,
    '  --context) case "$3" in',
    `    build) cat >/dev/null; ${answers.build} ;;`,
    '    version) echo 29 ;;',
    `    image) ${answers.contextImage ?? 'exit 0'} ;;`,
    '    volume) case "$4" in inspect) echo 1 ;; esac ;;',
    `    run) ${answers.run ?? 'exit 0'} ;;`,
    '    start|rm) exit 0 ;;',
    `    exec) case "$4" in -u) ${answers.prepare ?? answers.exec} ;; *) ${answers.exec} ;; esac ;;`,
    '    inspect) echo 1 ;;',
    '  esac ;;',
    'esac',
  ].join('\n')
}

test('an image that does not build leaves no container and no record', async () => {
  const { machines, dir } = setup(
    loggingDocker({ image: 'exit 1', build: 'echo "no space left" >&2; exit 1', exec: 'exit 1' }),
  )
  const containers = new ContainerMachines({
    machines,
    image: async () => STAND_IN_IMAGE,
    hostLabel: () => 'this Mac',
  })
  const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
  assert.match(created.ok ? '' : created.message, /did not build on this Mac: no space left/u)
  assert.equal(machines.list().filter((entry) => entry.container).length, 0, 'no record')
  const calls = readFileSync(join(dir, 'calls'), 'utf8')
  assert.doesNotMatch(calls, / run /u, 'nothing was started')
  machines.shutdown()
})

test('a container whose server cannot be reached is removed again, its home volume with it', async () => {
  const { machines, dir } = setup(
    loggingDocker({ image: 'exit 0', build: 'exit 0', exec: 'echo "exec failed" >&2; exit 1' }),
  )
  const containers = new ContainerMachines({
    machines,
    image: async () => STAND_IN_IMAGE,
    hostLabel: () => 'this Mac',
  })
  const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
  assert.equal(created.ok, false)
  assert.equal(machines.list().filter((entry) => entry.container).length, 0, 'no record')
  const calls = readFileSync(join(dir, 'calls'), 'utf8')
  const name = /--name (sprintengine-[a-f0-9]{16})/u.exec(calls)?.[1]
  assert.ok(name, 'it was started')
  assert.match(calls, new RegExp(`--context colima rm -f ${name}`, 'u'))
  assert.match(calls, new RegExp(`--context colima volume rm ${name}-home`, 'u'))
  machines.shutdown()
}, 60_000)

test('New container refuses a name already taken and an address that is not a repository, before Docker is asked', async () => {
  const { machines, dir } = setup('echo asked >> "$HOME/asked"', [localContainer('0123456789abcdef')])
  const containers = new ContainerMachines({
    machines,
    image: async () => STAND_IN_IMAGE,
    hostLabel: () => 'this Mac',
  })
  const taken = await containers.create({ host: { kind: 'local' }, label: '0123456789abcdef (container)', clone: null })
  assert.match(taken.ok ? '' : taken.message, /is already one of your machines/u)
  const bad = await containers.create({ host: { kind: 'local' }, label: 'other', clone: '--upload-pack=id' })
  assert.match(bad.ok ? '' : bad.message, /is not a repository address/u)
  const unnamed = await containers.create({ host: { kind: 'local' }, label: '  ', clone: null })
  assert.match(unnamed.ok ? '' : unnamed.message, /Give the container a name/u)
  assert.throws(() => readFileSync(join(dir, 'asked')), 'Docker was never asked')
  machines.shutdown()
})

test('a container whose logins cannot be readied is removed again, and says why', async () => {
  const { machines, dir } = setup(
    loggingDocker({
      image: 'exit 0',
      build: 'exit 0',
      exec: 'exit 1',
      prepare: 'echo "read-only file system" >&2; exit 1',
    }),
  )
  const containers = new ContainerMachines({ machines, image: async () => STAND_IN_IMAGE, hostLabel: () => 'this Mac' })
  const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
  assert.match(
    created.ok ? '' : created.message,
    /The logins could not be readied in the container: read-only file system/u,
  )
  assert.equal(machines.list().filter((entry) => entry.container).length, 0, 'no record')
  assert.match(readFileSync(join(dir, 'calls'), 'utf8'), /--context colima rm -f sprintengine-/u)
  machines.shutdown()
})

/** A saved container under the Colima context, on an older image than `STAND_IN_IMAGE`. */
const olderContainer = () => {
  const entry = localContainer('0123456789abcdef')
  entry.container = { ...entry.container!, context: 'colima', image: 'sprintengine-studio-agent:aaaaaaaaaaaa' }
  return entry
}
const NEXT = { ...STAND_IN_IMAGE, agents: [{ cli: 'codex', name: 'Codex', version: '0.169.0' }] }

test('Rebuild looks for the new image under the container’s own context, and builds nothing already there', async () => {
  const { machines, dir } = setup(
    // Not under the default context, but there under the container's.
    loggingDocker({ image: 'exit 1', contextImage: 'exit 0', build: 'exit 0', exec: 'exit 0' }),
    [olderContainer()],
  )
  const containers = new ContainerMachines({
    machines,
    image: async () => NEXT,
    hostLabel: () => 'this Mac',
    timing: { runMs: 5_000 },
  })
  await containers.rebuild('0123456789abcdef')
  const calls = readFileSync(join(dir, 'calls'), 'utf8')
  assert.doesNotMatch(calls, / build /u, 'nothing built')
  assert.match(calls, /--context colima image inspect sprintengine-studio-agent:0123456789ab/u)
  machines.shutdown()
}, 60_000)

test('a Rebuild whose new container does not start says so, and keeps the old image on the record so it is offered again', async () => {
  const { machines } = setup(
    loggingDocker({
      image: 'exit 0',
      build: 'exit 0',
      exec: 'exit 0',
      run: 'echo "port is already allocated" >&2; exit 125',
    }),
    [olderContainer()],
  )
  const containers = new ContainerMachines({ machines, image: async () => NEXT, hostLabel: () => 'this Mac' })
  const rebuilt = await containers.rebuild('0123456789abcdef')
  assert.equal(rebuilt.ok, false)
  assert.match(rebuilt.ok ? '' : rebuilt.message, /was not made again on this Mac: port is already allocated/u)
  assert.equal(machines.get('0123456789abcdef')?.container?.image, 'sprintengine-studio-agent:aaaaaaaaaaaa')
  machines.shutdown()
})

test('a Rebuild whose server cannot be reached afterwards says so, the record on the new image it now runs', async () => {
  const { machines } = setup(
    loggingDocker({ image: 'exit 0', build: 'exit 0', exec: 'echo "exec failed" >&2; exit 1', prepare: 'exit 0' }),
    [olderContainer()],
  )
  const containers = new ContainerMachines({ machines, image: async () => NEXT, hostLabel: () => 'this Mac' })
  const rebuilt = await containers.rebuild('0123456789abcdef')
  assert.equal(rebuilt.ok, false)
  assert.equal(machines.get('0123456789abcdef')?.container?.image, STAND_IN_IMAGE.tag)
  assert.deepEqual(machines.get('0123456789abcdef')?.container?.agents, ['codex'])
  machines.shutdown()
}, 60_000)

test('which agents are set up cannot be told: no container is made, and New container says why', async () => {
  const { machines, dir } = setup(loggingDocker({ image: 'exit 0', build: 'exit 0', exec: 'exit 0' }))
  const containers = new ContainerMachines({
    machines,
    image: async () => {
      throw new Error('Studio could not tell whether Codex is set up on this computer.')
    },
    hostLabel: () => 'this Mac',
  })
  const status = await containers.status({ kind: 'local' })
  assert.equal(status.imageProblem, 'Studio could not tell whether Codex is set up on this computer.')
  assert.equal(status.image, undefined)
  const created = await containers.create({ host: { kind: 'local' }, label: 'sandbox', clone: null })
  assert.match(created.ok ? '' : created.message, /could not tell whether Codex is set up/u)
  assert.doesNotMatch(readFileSync(join(dir, 'calls'), 'utf8'), / run /u)
  machines.shutdown()
})
