import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { CliInstallResult } from '../shared/electron-api'
import type { CliUpdateAllItem } from '../shared/ipc/cli-update-all'
import type { CliUpdateTarget } from './cli-version-advisory-service'

// Update everything: every outdated CLI on every machine, each through the
// lock and updater a row's Update takes; one machine's CLIs one after another,
// machines beside each other; everyone following told as each item moves.

const calls = vi.hoisted(() => ({
  updates: [] as Array<{ cli: string; hostId: string; at: number }>,
  finished: [] as string[],
  results: new Map<string, Partial<CliInstallResult>>(),
  gates: new Map<string, Promise<void>>(),
}))

vi.mock('./cli-runtime-install', () => ({
  cliInstallMethods: async () => [],
  detectCli: async () => ({}),
  installCli: async () => ({}),
  updateCli: async (cli: string, runtime: { hostId?: string } | undefined) => {
    const hostId = runtime?.hostId ?? 'local'
    const key = `${hostId}/${cli}`
    calls.updates.push({ cli, hostId, at: calls.updates.length })
    await calls.gates.get(key)
    calls.finished.push(key)
    return {
      ok: true,
      cli,
      installed: true,
      version: '2.0.0',
      resolvedPath: `/usr/local/bin/${cli}`,
      log: '',
      error: null,
      ...calls.results.get(key),
    }
  },
}))
vi.mock('./cli-version-advisory-service', () => ({
  noteCliDetected: async () => undefined,
  outdatedCliTargets: async () => ({ ok: true, targets: [] }),
  onCliVersionAdvisoriesChanged: () => () => undefined,
  readCliVersionAdvisories: async () => ({ ok: false, message: 'not in this test' }),
  setCliVersionChecksEnabled: (enabled: boolean) => enabled,
}))
vi.mock('./cli-availability', () => ({ recordCliDetection: () => undefined }))
vi.mock('./model-discovery/discovery-pass', () => ({ discoverAndBroadcastCliModels: async () => undefined }))

const { createCliRuntimes } = await import('./cli-runtimes')

let targets: CliUpdateTarget[] = []
const runtimes = createCliRuntimes({
  discoverModels: async () => undefined,
  outdatedTargets: async () => ({ ok: true, targets }),
})

/** What a follower of the progress hears. */
function follower() {
  const progress: CliUpdateAllItem[][] = []
  const stop = runtimes.onUpdateAllProgress((items) => void progress.push(items))
  return { progress, stop }
}

const target = (hostId: string, cli: string, from = '1.0.0'): CliUpdateTarget =>
  ({
    hostId,
    cli,
    runtime: hostId === 'local' ? undefined : { command: '', hostId },
    currentVersion: from,
    latestVersion: '2.0.0',
  }) as CliUpdateTarget

beforeEach(() => {
  calls.updates.length = 0
  calls.finished.length = 0
  calls.results.clear()
  calls.gates.clear()
})

test('each outdated CLI is updated, a machine at a time per machine, and says how it went', async () => {
  targets = [target('local', 'codex'), target('local', 'claude-code'), target('wsl:Ubuntu', 'codex')]
  calls.results.set('local/claude-code', { ok: false, error: 'npm ERR! EACCES' })
  let releaseLocal!: () => void
  calls.gates.set('local/codex', new Promise((resolve) => (releaseLocal = resolve)))
  const { progress, stop } = follower()
  const running = runtimes.updateAll()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    calls.updates.map((update) => `${update.hostId}/${update.cli}`),
    ['local/codex', 'wsl:Ubuntu/codex'],
    'the distribution runs beside this machine; this machine’s second CLI waits for its first',
  )
  releaseLocal()
  const result = await running
  assert.ok(result.ok)
  assert.deepEqual(
    result.items.map((item) => [item.hostId, item.cli, item.state]),
    [
      ['local', 'codex', 'updated'],
      ['local', 'claude-code', 'failed'],
      ['wsl:Ubuntu', 'codex', 'updated'],
    ],
  )
  assert.equal(result.items[1]!.error, 'npm ERR! EACCES')
  assert.equal(result.items[0]!.to, '2.0.0')
  assert.deepEqual(
    progress[0]!.map((item) => item.state),
    ['queued', 'queued', 'queued'],
    'the window sees the list before anything runs',
  )
  assert.ok(progress.some((items) => items[0]!.state === 'updating'))
  stop()
})

test('a version that did not move is said as such, not as updated', async () => {
  targets = [target('local', 'codex', '2.0.0')]
  const result = await runtimes.updateAll()
  assert.ok(result.ok)
  assert.equal(result.items[0]!.state, 'unchanged')
})

test('a second press while one runs joins it, and a row already updating a CLI is joined, not run twice', async () => {
  targets = [target('local', 'codex')]
  let release!: () => void
  calls.gates.set('local/codex', new Promise((resolve) => (release = resolve)))
  const row = runtimes.update('codex')
  const heard = follower()
  const a = runtimes.updateAll()
  const b = runtimes.updateAll()
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  const [ra, rb] = await Promise.all([a, b, row])
  assert.equal(ra, rb, 'the same answer for both presses')
  assert.equal(calls.updates.length, 1, 'codex was updated once')
  assert.ok(heard.progress.length > 0, 'a follower is told')
  heard.stop()
})

test('nothing outdated answers with no items', async () => {
  targets = []
  const result = await runtimes.updateAll()
  assert.deepEqual(result, { ok: true, items: [] })
  assert.equal(calls.updates.length, 0)
})
