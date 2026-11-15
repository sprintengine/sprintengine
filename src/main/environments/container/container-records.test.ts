import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SavedSshEnvironment } from '../../../shared/ssh-environments'
import { SshEnvironments } from '../ssh/ssh-environments'
import { ContainerMachines } from './container-machines'
import { imageFor } from './container-image'
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
  assert.deepEqual(refused.containers, ['sprintengine-0123456789abcdef'])
  assert.match(
    refused.ok ? '' : refused.message,
    /build-box has a container Studio made \(sprintengine-0123456789abcdef\)/u,
  )
  assert.ok(machines.get('aaaaaaaaaaaaaaaa') && machines.get('0123456789abcdef'), 'both still saved')
  const dropped = await machines.forget('aaaaaaaaaaaaaaaa', { containers: 'forget-records' })
  assert.equal(dropped.ok, true)
  assert.equal(machines.get('aaaaaaaaaaaaaaaa'), null)
  assert.equal(machines.get('0123456789abcdef'), null)
  machines.shutdown()
})

test('a container is saved before Docker is asked to start it; one cut short stays listed', async () => {
  const { machines } = setup(
    [
      'case "$1" in',
      '  version) echo 29.2.1 ;;',
      '  context) echo colima ;;',
      '  image) exit 0 ;;',
      // Docker is asked to start it and does not answer.
      '  --context) case "$3" in run) sleep 5 ;; version) echo 29 ;; inspect) echo "Cannot connect" >&2; exit 1 ;; esac ;;',
      'esac',
    ].join('\n'),
  )
  const containers = new ContainerMachines({
    machines,
    image: () => imageFor('FROM scratch\n'),
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

test('New container refuses a name already taken and an address that is not a repository, before Docker is asked', async () => {
  const { machines, dir } = setup('echo asked >> "$HOME/asked"', [localContainer('0123456789abcdef')])
  const containers = new ContainerMachines({
    machines,
    image: () => imageFor('FROM scratch\n'),
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
