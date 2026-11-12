import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { formatEnvironmentRoute, type EnvironmentDescriptor } from '../../../packages/studio-protocol/src/environment'
import { meshEnvironmentSource, sshEnvironmentSource, wslEnvironmentSources } from '../../shared/environment-keys'
import { emptyExecutionHostSettings, wslHostId } from '../../shared/execution-host'
import { createEnvironmentRegistry, ENVIRONMENTS_FILENAME, type KnownEnvironment } from './environment-registry'

const LOCAL = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
const UBUNTU = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const MINI = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a'
const BOX = '0f8e2b1c-3a4d-4e5f-8a9b-1c2d3e4f5a6b'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(join(directory, ENVIRONMENTS_FILENAME), 0o600)
    } catch {
      // Not there.
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'environment-registry-'))
  directories.push(directory)
  return directory
}

function registry(dir: string, platform = 'win32', log?: (message: string) => void) {
  return createEnvironmentRegistry({ userDataDir: dir, localEnvironmentId: LOCAL, platform, ...(log ? { log } : {}) })
}

const enabled = { ...emptyExecutionHostSettings(), enabled: true }
const wsl = (...distros: string[]) =>
  wslEnvironmentSources(Object.fromEntries(distros.map((distro) => [wslHostId(distro), enabled])), 'win32')
const ssh = (id: string, label: string, environmentId: string | null) =>
  sshEnvironmentSource({ id, label, destination: `dev@${label}`, resolved: null, environmentId })
const paired = (id: string, machineName: string, environmentId?: string) =>
  meshEnvironmentSource({ id, machineName, ...(environmentId ? { environmentId } : {}) })

const summary = (list: KnownEnvironment[]) =>
  list.map((entry) => [entry.environmentId, entry.displayName, entry.routes.map(formatEnvironmentRoute)])

function descriptor(environmentId: string, displayName: string): EnvironmentDescriptor {
  return {
    environmentId,
    kind: 'wsl',
    displayName,
    serverVersion: '0.40.0',
    protocolVersion: 1,
    minProtocolVersion: 1,
    capabilities: ['conversations'],
  }
}

test('this machine is always first, under its own id, before anything is observed', () => {
  const environments = registry(dataDir(), 'darwin')
  assert.deepEqual(summary(environments.list()), [[LOCAL, 'This Mac', ['local']]])
  assert.equal(environments.environmentOfRoute({ kind: 'local' }), LOCAL)
  assert.deepEqual(environments.get(LOCAL)?.machine, { kind: 'local' })
})

test('every machine known today is listed, best route first, a machine not reached yet without an id', () => {
  const environments = registry(dataDir())
  environments.observe('ssh', [ssh('m_box', 'build-box', BOX), ssh('m_new', 'fresh-vm', null)])
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  environments.observe('wsl', wsl('Ubuntu'))
  assert.deepEqual(summary(environments.list()), [
    [LOCAL, 'This PC (Windows)', ['local']],
    [null, 'WSL: Ubuntu', ['wsl:Ubuntu']],
    [MINI, 'mac-mini', ['tailnet:tnc_1']],
    [BOX, 'build-box', ['ssh:m_box']],
    [null, 'fresh-vm', ['ssh:m_new']],
  ])
  assert.equal(environments.environmentOfRoute({ kind: 'ssh', machine: 'm_box' }), BOX)
  assert.equal(environments.environmentOfRoute({ kind: 'ssh', machine: 'm_new' }), null)
})

test('one Studio reached two ways is one environment, its routes in order and its name the best route’s', () => {
  const environments = registry(dataDir())
  environments.observe('ssh', [ssh('m_mini', 'mini over ssh', MINI)])
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  assert.deepEqual(summary(environments.list()).slice(1), [[MINI, 'mac-mini', ['tailnet:tnc_1', 'ssh:m_mini']]])
  assert.deepEqual(environments.get(MINI)?.machine, { kind: 'paired', name: 'mac-mini' })
})

test('what a route answered survives a restart', () => {
  const dir = dataDir()
  const first = registry(dir)
  first.observe('wsl', wsl('Ubuntu'))
  assert.equal(first.learn({ kind: 'wsl', distro: 'Ubuntu' }, descriptor(UBUNTU, 'WSL: Ubuntu')), true)
  assert.equal(first.learn({ kind: 'wsl', distro: 'Ubuntu' }, descriptor(UBUNTU, 'WSL: Ubuntu')), false, 'not news')
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, ENVIRONMENTS_FILENAME)).mode & 0o777, 0o600)

  const second = registry(dir)
  second.observe('wsl', wsl('Ubuntu'))
  assert.deepEqual(summary(second.list()).slice(1), [[UBUNTU, 'WSL: Ubuntu', ['wsl:Ubuntu']]])
  assert.equal(second.get(UBUNTU)?.descriptor?.serverVersion, '0.40.0')
  // The id a paired desktop gave is kept too, though a later read of its record lacks it.
  first.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  const third = registry(dir)
  assert.equal(third.environmentOfRoute({ kind: 'tailnet', connection: 'tnc_1' }), null, 'not listed yet')
  third.observe('tailnet', [paired('tnc_1', 'mac-mini')])
  assert.equal(third.environmentOfRoute({ kind: 'tailnet', connection: 'tnc_1' }), MINI)
  // Forgotten: no owner lists the route, so it reaches nothing.
  third.observe('tailnet', [])
  assert.equal(third.environmentOfRoute({ kind: 'tailnet', connection: 'tnc_1' }), null)
})

test('a record from disk that names no route is left out, never thrown on', () => {
  const logs: string[] = []
  const environments = registry(dataDir(), 'win32', (message) => logs.push(message))
  environments.observe('ssh', [ssh('bad/id', 'odd', BOX), ssh('m_box', 'build-box', 'not:an-id')])
  environments.observe('tailnet', [paired('', 'nameless')])
  assert.deepEqual(summary(environments.list()).slice(1), [[null, 'build-box', ['ssh:m_box']]])
  assert.equal(logs.length, 2)
  assert.equal(environments.environmentOfRoute({ kind: 'ssh', machine: 'bad/id' }), null)
  assert.equal(environments.learn({ kind: 'ssh', machine: 'bad/id' }, BOX), false)
})

test('another machine answering with this machine’s id is listed apart, never merged into it', () => {
  const logs: string[] = []
  const environments = registry(dataDir(), 'win32', (message) => logs.push(message))
  // A data directory copied from here to another machine.
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', LOCAL)])
  assert.deepEqual(summary(environments.list()), [
    [LOCAL, 'This PC (Windows)', ['local']],
    [null, 'mac-mini', ['tailnet:tnc_1']],
  ])
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', LOCAL)])
  assert.equal(logs.length, 1, 'said once')
  // Nor is it written down as this machine.
  assert.equal(environments.learn({ kind: 'tailnet', connection: 'tnc_1' }, LOCAL), false)
})

test('a renamed machine keeps its id: a new WSL name that answers as the old Studio joins it', () => {
  const dir = dataDir()
  const environments = registry(dir)
  environments.observe('wsl', wsl('Ubuntu'))
  environments.learn({ kind: 'wsl', distro: 'Ubuntu' }, UBUNTU)
  // Renamed in WSL: a new route, not yet heard from.
  environments.observe('wsl', wsl('Ubuntu-Work'))
  assert.deepEqual(summary(environments.list()).slice(1), [[null, 'WSL: Ubuntu-Work', ['wsl:Ubuntu-Work']]])
  environments.learn({ kind: 'wsl', distro: 'Ubuntu-Work' }, UBUNTU)
  assert.deepEqual(summary(registry(dir).list()).slice(1), [])
  const after = registry(dir)
  after.observe('wsl', wsl('Ubuntu-Work'))
  assert.deepEqual(summary(after.list()).slice(1), [[UBUNTU, 'WSL: Ubuntu-Work', ['wsl:Ubuntu-Work']]])
  // A paired desktop renamed on the tailnet is the same pairing, under its new name.
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  environments.observe('tailnet', [paired('tnc_1', 'studio-mini', MINI)])
  assert.equal(environments.get(MINI)?.displayName, 'studio-mini')
})

test('a route that now answers as another Studio leaves the environment it was in', () => {
  const environments = registry(dataDir())
  environments.observe('ssh', [ssh('m_mini', 'mini over ssh', MINI)])
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  // The SSH alias now reaches another machine.
  environments.observe('ssh', [ssh('m_mini', 'mini over ssh', BOX)])
  assert.deepEqual(summary(environments.list()).slice(1), [
    [MINI, 'mac-mini', ['tailnet:tnc_1']],
    [BOX, 'mini over ssh', ['ssh:m_mini']],
  ])
})

test('a change is announced once, and an unchanged observation is not', () => {
  const environments = registry(dataDir())
  let calls = 0
  const stop = environments.onChanged(() => (calls += 1))
  environments.observe('wsl', wsl('Ubuntu'))
  environments.observe('wsl', wsl('Ubuntu'))
  assert.equal(calls, 1)
  environments.learn({ kind: 'wsl', distro: 'Ubuntu' }, UBUNTU)
  assert.equal(calls, 2)
  stop()
  environments.observe('wsl', [])
  assert.equal(calls, 2)
  // Sources of another kind are not taken under this one.
  environments.observe('wsl', [ssh('m_box', 'build-box', BOX)])
  assert.deepEqual(summary(environments.list()), [[LOCAL, 'This PC (Windows)', ['local']]])
  assert.equal(environments.learn({ kind: 'wsl', distro: 'Ubuntu' }, 'not:an-id'), false)
})

test('a list handed out is a copy', () => {
  const environments = registry(dataDir())
  const list = environments.list()
  list[0]!.routes.push({ kind: 'ssh', machine: 'x' })
  assert.deepEqual(environments.list()[0]!.routes, [{ kind: 'local' }])
})

test('a file that is not JSON is kept aside at the first write, and entries that do not read are dropped', () => {
  const dir = dataDir()
  writeFileSync(join(dir, ENVIRONMENTS_FILENAME), '{ not json')
  const environments = registry(dir)
  environments.learn({ kind: 'wsl', distro: 'Ubuntu' }, UBUNTU)
  assert.equal(readdirSync(dir).filter((name) => name.includes('.malformed-')).length, 1)

  writeFileSync(
    join(dir, ENVIRONMENTS_FILENAME),
    JSON.stringify({
      version: 1,
      routes: { 'wsl:Ubuntu': UBUNTU, 'lan:10.0.0.2': BOX, 'ssh:m1': 'a:b' },
      environments: { [UBUNTU]: { descriptor: descriptor(BOX, 'wrong id') } },
    }),
  )
  const reread = registry(dir)
  reread.observe('wsl', wsl('Ubuntu'))
  reread.observe('ssh', [ssh('m1', 'm1', null)])
  assert.equal(reread.environmentOfRoute({ kind: 'wsl', distro: 'Ubuntu' }), UBUNTU)
  assert.equal(reread.environmentOfRoute({ kind: 'ssh', machine: 'm1' }), null)
  assert.equal(reread.get(UBUNTU)?.descriptor, null)
})

test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'a file that cannot be read is never written over',
  () => {
    const dir = dataDir()
    const path = join(dir, ENVIRONMENTS_FILENAME)
    writeFileSync(path, JSON.stringify({ version: 1, routes: { 'wsl:Ubuntu': UBUNTU }, environments: {} }))
    chmodSync(path, 0o000)
    const logs: string[] = []
    const environments = registry(dir, 'win32', (message) => logs.push(message))
    environments.learn({ kind: 'wsl', distro: 'Debian' }, BOX)
    chmodSync(path, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).routes, { 'wsl:Ubuntu': UBUNTU })
    assert.equal(logs.length, 1)
  },
)

test('each environment reads as its routes’ owners report: up on any way in, else its best route', () => {
  const environments = registry(dataDir())
  environments.observe('tailnet', [paired('tnc_1', 'mac-mini', MINI)])
  environments.observe('ssh', [ssh('m_mini', 'mac-mini-ssh', MINI), ssh('m_box', 'build-box', BOX)])
  const connection = (id: string) => environments.get(id)?.connection
  // Nothing reported yet: unknown, and so is its compatibility.
  assert.deepEqual(connection(MINI), { state: 'unknown', detail: null, lastReachedAt: null })
  assert.equal(environments.get(MINI)?.compatibility, 'unknown')

  environments.report('tailnet', [
    {
      route: { kind: 'tailnet', connection: 'tnc_1' },
      connection: { state: 'offline', detail: null, lastReachedAt: 5 },
    },
  ])
  assert.equal(connection(MINI)?.state, 'offline')
  // The SSH route answers: the machine answers, whichever route is best.
  environments.report('ssh', [
    { route: { kind: 'ssh', machine: 'm_mini' }, connection: { state: 'up', detail: null, lastReachedAt: null } },
    {
      route: { kind: 'ssh', machine: 'm_box' },
      connection: { state: 'connecting', detail: 'Installing', lastReachedAt: null },
    },
  ])
  assert.equal(connection(MINI)?.state, 'up')
  assert.deepEqual(connection(BOX), { state: 'connecting', detail: 'Installing', lastReachedAt: null })

  // A report is whole for its kind: one that leaves a route out forgets it.
  environments.report('ssh', [])
  assert.equal(connection(MINI)?.state, 'offline')
  assert.equal(connection(BOX)?.state, 'unknown')
  // A report of another kind's route is not taken.
  environments.report('wsl', [
    { route: { kind: 'ssh', machine: 'm_box' }, connection: { state: 'up', detail: null, lastReachedAt: null } },
  ])
  assert.equal(connection(BOX)?.state, 'unknown')
})

test('a changed report is announced, an unchanged one is not', () => {
  const environments = registry(dataDir())
  environments.observe('ssh', [ssh('m_box', 'build-box', BOX)])
  let calls = 0
  environments.onChanged(() => calls++)
  const report = (state: 'up' | 'offline') =>
    environments.report('ssh', [
      { route: { kind: 'ssh', machine: 'm_box' }, connection: { state, detail: null, lastReachedAt: null } },
    ])
  report('up')
  report('up')
  assert.equal(calls, 1)
  report('offline')
  assert.equal(calls, 2)
})

test("each machine's compatibility is read from the window its server last said, against this build's", () => {
  const dir = dataDir()
  const known = registry(dir)
  known.observe('ssh', [ssh('box', 'build-box', BOX), ssh('new', 'new-box', null)])
  known.observe('wsl', wsl('Ubuntu'))
  const compat = (list: KnownEnvironment[]) => list.map((entry) => [entry.displayName, entry.compatibility])
  // Nothing heard yet: unknown; this machine is the one asking.
  assert.deepEqual(compat(known.list()), [
    ['This PC (Windows)', 'compatible'],
    ['WSL: Ubuntu', 'unknown'],
    ['build-box', 'unknown'],
    ['new-box', 'unknown'],
  ])
  const up = { state: 'up' as const, detail: null, lastReachedAt: null }
  const offline = { state: 'offline' as const, detail: null, lastReachedAt: null }
  known.report('ssh', [
    // A server far past this build, and one far behind it, as their records said.
    { route: { kind: 'ssh', machine: 'box' }, connection: offline, window: { protocolVersion: 99, minProtocolVersion: 98 } },
    { route: { kind: 'ssh', machine: 'new' }, connection: offline, window: { protocolVersion: 0.5, minProtocolVersion: 1 } },
  ])
  known.learn({ kind: 'wsl', distro: 'Ubuntu' }, descriptor(UBUNTU, 'WSL: Ubuntu'))
  assert.deepEqual(compat(known.list()).slice(1), [
    ['WSL: Ubuntu', 'compatible'],
    ['build-box', 'client-outdated'],
    ['new-box', 'unknown'],
  ])
  // A report with no window leaves what was heard.
  known.report('ssh', [{ route: { kind: 'ssh', machine: 'box' }, connection: up }])
  assert.equal(known.get(BOX)?.compatibility, 'client-outdated')
  // Kept beside the descriptor across a restart, for a machine with an id.
  const again = registry(dir)
  again.observe('ssh', [ssh('box', 'build-box', BOX)])
  assert.equal(again.get(BOX)?.compatibility, 'client-outdated')
  const stored = JSON.parse(readFileSync(join(dir, ENVIRONMENTS_FILENAME), 'utf8')) as {
    environments: Record<string, unknown>
  }
  assert.deepEqual(stored.environments[BOX], { window: { protocolVersion: 99, minProtocolVersion: 98 } })
  // The server updated: the next window heard is the one that counts.
  again.report('ssh', [{ route: { kind: 'ssh', machine: 'box' }, connection: up, window: { protocolVersion: 1, minProtocolVersion: 1 } }])
  assert.equal(again.get(BOX)?.compatibility, 'compatible')
})
