import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import type { CliModelDiscoveryInput, CliModelDiscoveryResult } from '../../shared/ipc/cli-model-discovery'
import { discoverAndBroadcastCliModels, onCliModelsChanged } from './discovery-pass'

const CATALOG: DiscoveredCliModelCatalog = {
  models: [{ id: 'grok-4.6' }],
  fetchedAt: '2026-09-22T10:00:00.000Z',
  source: 'argv-probe',
}

const RESULT: CliModelDiscoveryResult = {
  startedAt: '2026-09-22T10:00:00.000Z',
  finishedAt: '2026-09-22T10:00:01.000Z',
  entries: [
    { cli: 'grok', catalog: CATALOG },
    { cli: 'codex', catalog: CATALOG, skipped: 'fresh' },
    { cli: 'cursor', catalog: null, error: 'Cursor did not print a model list.' },
    { cli: 'kimi-code', catalog: null, skipped: 'no-probe' },
  ],
}

function follower() {
  const heard: CliModelDiscoveryResult[] = []
  const stop = onCliModelsChanged((result) => void heard.push(result))
  return { heard, stop }
}

test('only catalogs a probe produced are told, to every follower until it stops', async () => {
  const a = follower()
  const b = follower()
  const gone = follower()
  gone.stop()
  const result = await discoverAndBroadcastCliModels({}, { discover: async () => RESULT })
  assert.equal(result, RESULT, 'the caller gets the whole answer, skips and errors included')
  const expected = { ...RESULT, entries: [RESULT.entries[0]] }
  assert.deepEqual(a.heard, [expected])
  assert.deepEqual(b.heard, [expected])
  assert.deepEqual(gone.heard, [])
  a.stop()
  b.stop()
})

test('a pass that produced nothing tells nothing', async () => {
  const one = follower()
  await discoverAndBroadcastCliModels({}, { discover: async () => ({ ...RESULT, entries: RESULT.entries.slice(1) }) })
  assert.deepEqual(one.heard, [])
  one.stop()
})

test("a pass main starts itself runs with the mirrored per-CLI overrides; a window's own win", async () => {
  const inputs: CliModelDiscoveryInput[] = []
  const deps = {
    discover: async (input: CliModelDiscoveryInput) => {
      inputs.push(input)
      return { ...RESULT, entries: [] }
    },
    mainCliRuntimes: () => ({
      codex: { command: '/opt/codex/bin/codex' },
      'claude-code': { command: '', hostId: 'wsl:Ubuntu' as const },
    }),
  }
  await discoverAndBroadcastCliModels({ clis: ['codex'] }, deps)
  await discoverAndBroadcastCliModels({ cliRuntimes: { codex: { command: 'codex' } } }, deps)
  await discoverAndBroadcastCliModels({}, { ...deps, mainCliRuntimes: () => ({}) })
  await discoverAndBroadcastCliModels(
    {},
    {
      ...deps,
      mainCliRuntimes: () => {
        throw new Error('mirror unreadable')
      },
    },
  )
  assert.deepEqual(inputs, [
    { clis: ['codex'], cliRuntimes: deps.mainCliRuntimes() },
    { cliRuntimes: { codex: { command: 'codex' } } },
    {},
    {},
  ])
})
