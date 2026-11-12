import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { readModuleOverridesSync } from '../module-host/enablement-store'
import { createModuleLifecycle, liveModuleIds, summarizeModules, type ModuleLifecycleView } from './module-lifecycle'

// The lifecycle's own rules: which switches apply at once, how a module is
// listed, and that switches arriving together are each kept. Its whole path
// over the protocol is src/seams/moduleLifecycleSeam.test.ts.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const manifest = (id: string, extra: Partial<CapabilityManifest> = {}): CapabilityManifest => ({
  id,
  displayName: id,
  version: 1,
  defaultEnabled: true,
  ...extra,
})

test('every installed extension switches at once, except one whose main half failed at start', () => {
  const live = liveModuleIds(['deck', 'broken'], [{ id: 'broken' }])
  assert.ok(live.includes('deck'))
  assert.ok(live.includes('scheduled-agents'), 'the bundled ones that could still can')
  assert.equal(live.includes('broken'), false)
})

test('a module is listed with its switch, whether it runs, why not, and what it declares while it runs', () => {
  const view: ModuleLifecycleView = {
    manifests: () => [
      manifest('deck', { source: 'third-party' }),
      manifest('waiting', { source: 'third-party' }),
      manifest('off'),
    ],
    enabled: (id) => id !== 'off',
    running: (id) => id === 'deck',
    ineligible: (id) => (id === 'waiting' ? 'untrusted' : undefined),
    loadError: () => undefined,
    declaredMethods: (id) => (id === 'deck' ? [{ name: 'cards.list', access: 'read' }] : []),
  }
  assert.deepEqual(summarizeModules(view), [
    {
      id: 'deck',
      name: 'deck',
      version: 1,
      source: 'third-party',
      enabled: true,
      running: true,
      methods: [{ name: 'cards.list', access: 'read' }],
    },
    {
      id: 'waiting',
      name: 'waiting',
      version: 1,
      source: 'third-party',
      enabled: true,
      running: false,
      blocked: 'It waits to be trusted.',
      methods: [],
    },
    { id: 'off', name: 'off', version: 1, source: 'bundled', enabled: false, running: false, methods: [] },
  ])
})

test('switches sent together are each kept, applied in order, and null is back to the default', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const applied: Array<Record<string, boolean>> = []
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'modules'),
    view: () => null,
    applyEnablement: async (overrides) => {
      applied.push(overrides)
      return { ok: true }
    },
    changed: () => undefined,
  })
  await Promise.all([
    lifecycle.setEnabled('a', false),
    lifecycle.setEnabled('b', true),
    lifecycle.setEnabled('c', false),
  ])
  assert.deepEqual(readModuleOverridesSync(dataDir), { a: false, b: true, c: false })
  assert.deepEqual(applied.at(-1), { a: false, b: true, c: false })
  await lifecycle.setEnabled('b', null)
  assert.deepEqual(readModuleOverridesSync(dataDir), { a: false, c: false })
  assert.equal((await lifecycle.setEnabled('../x', true)).ok, false, 'not a module id')
})

test('a switch that cannot be applied now is still kept for the next start, and says why', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'modules'),
    view: () => null,
    applyEnablement: async () => ({ ok: false, message: 'Scheduled agents could not start.' }),
    changed: () => undefined,
  })
  assert.deepEqual(await lifecycle.setEnabled('scheduled-agents', true), {
    ok: false,
    message: 'Scheduled agents could not start.',
  })
  assert.deepEqual(readModuleOverridesSync(dataDir), { 'scheduled-agents': true })
})
