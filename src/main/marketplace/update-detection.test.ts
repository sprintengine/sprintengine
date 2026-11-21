import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MarketplaceRegistryReadResult } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { readMarketplaceUpdateStates, type MarketplaceUpdateStatesServices } from './update-detection'
import { test } from 'vitest'

test('update-detection', async () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-update-detection-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  function registryEntry(id: string, latest: number): MarketplacePluginEntry {
    return {
      id,
      name: `${id} Plugin`,
      publisher: { name: 'SprintEngine Labs', verified: true },
      summary: `${id} summary.`,
      category: 'dev-tools',
      icon: `icons/${id}.svg`,
      latest,
      provides: ['mcp'],
      source: `https://github.com/sprintengine/studio-releases/tree/main/plugins/${id}`,
    }
  }

  function okRegistry(entries: MarketplacePluginEntry[]): MarketplaceRegistryReadResult {
    return {
      ok: true,
      state: entries.length > 0 ? 'ok' : 'empty',
      registryUrl: 'https://registry.test/marketplace.json',
      source: 'network',
      stale: false,
      fetchedAt: '2026-08-01T00:00:00.000Z',
      marketplace: { schemaVersion: 1, plugins: entries },
    }
  }

  const unreachableRegistry: MarketplaceRegistryReadResult = {
    ok: false,
    state: 'fetch-error',
    registryUrl: 'https://registry.test/marketplace.json',
    stale: false,
    message: 'Marketplace registry fetch failed with HTTP 503.',
  }

  async function writeReceiptStore(path: string, receipts: Array<{ id: string; version: number }>): Promise<void> {
    const plugins = Object.fromEntries(
      receipts.map((receipt) => [
        receipt.id,
        {
          id: receipt.id,
          displayName: `${receipt.id} Plugin`,
          version: receipt.version,
          sourceUrl: '',
          classification: 'community',
          installedAt: '2026-08-01T00:00:00.000Z',
          components: [],
        },
      ]),
    )
    await writeFile(path, JSON.stringify({ schemaVersion: 2, plugins }, null, 2), 'utf8')
  }

  function services(
    temp: string,
    registry: MarketplaceRegistryReadResult,
  ): MarketplaceUpdateStatesServices & { reads: Array<{ forceRefresh?: boolean } | undefined> } {
    const reads: Array<{ forceRefresh?: boolean } | undefined> = []
    return {
      reads,
      registryReader: {
        async read(input) {
          reads.push(input)
          return registry
        },
      },
      receiptStorePath: join(temp, 'marketplace-installs.json'),
    }
  }

  function availabilityOf(result: Awaited<ReturnType<typeof readMarketplaceUpdateStates>>, id: string) {
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('unreachable')
    const entry = result.entries.find((candidate) => candidate.id === id)
    assert.ok(entry, `expected an update-state entry for ${id}`)
    return entry.availability
  }

  async function testReceiptStatesAgainstRegistryLatest(): Promise<void> {
    await withTempDir(async (temp) => {
      const svc = services(temp, okRegistry([registryEntry('behind', 2), registryEntry('level', 2)]))
      await writeReceiptStore(svc.receiptStorePath, [
        { id: 'behind', version: 1 },
        { id: 'level', version: 2 },
        { id: 'delisted', version: 1 },
      ])

      const result = await readMarketplaceUpdateStates(svc, { forceRefresh: true })
      assert.equal(result.ok && result.checked, true)
      assert.deepEqual(availabilityOf(result, 'behind'), {
        state: 'update-available',
        installedVersion: 1,
        latestVersion: 2,
      })
      assert.deepEqual(availabilityOf(result, 'level'), { state: 'current', installedVersion: 2, latestVersion: 2 })
      // Registry reachable but the id is gone: not knowable, never "up to date".
      assert.deepEqual(availabilityOf(result, 'delisted'), {
        state: 'unknown',
        installedVersion: 1,
        reason: 'not-in-registry',
      })
      assert.deepEqual(svc.reads, [{ forceRefresh: true }])
    })
  }

  async function testAnInstallCanBeAheadOfRegistry(): Promise<void> {
    await withTempDir(async (temp) => {
      const svc = services(temp, okRegistry([registryEntry('ahead', 2)]))
      // A registry that re-lists an older bundle than the one installed.
      await writeReceiptStore(svc.receiptStorePath, [{ id: 'ahead', version: 3 }])

      const availability = availabilityOf(await readMarketplaceUpdateStates(svc), 'ahead')
      assert.deepEqual(availability, { state: 'ahead-of-registry', installedVersion: 3, latestVersion: 2 })
      // A real state of its own — neither an update offer nor an error.
      assert.notEqual(availability.state, 'update-available')
      assert.notEqual(availability.state, 'unknown')
    })
  }

  async function testUnreachableRegistryReadsUnknownNeverCurrent(): Promise<void> {
    await withTempDir(async (temp) => {
      const svc = services(temp, unreachableRegistry)
      await writeReceiptStore(svc.receiptStorePath, [
        { id: 'behind', version: 1 },
        { id: 'ahead', version: 3 },
      ])

      const result = await readMarketplaceUpdateStates(svc)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.checked, false)
      assert.equal(result.registryState, 'fetch-error')
      assert.match(result.registryMessage ?? '', /HTTP 503/)
      assert.equal(result.entries.length, 2)
      // The couldn't-check state is distinct from up-to-date on every entry.
      for (const entry of result.entries) assert.notEqual(entry.availability.state, 'current')
      assert.deepEqual(availabilityOf(result, 'behind'), {
        state: 'unknown',
        installedVersion: 1,
        reason: 'registry-unreachable',
      })
      assert.deepEqual(availabilityOf(result, 'ahead'), {
        state: 'unknown',
        installedVersion: 3,
        reason: 'registry-unreachable',
      })
    })
  }

  async function testMalformedReceiptStoreFailsClosed(): Promise<void> {
    await withTempDir(async (temp) => {
      const svc = services(temp, okRegistry([]))
      await writeFile(svc.receiptStorePath, '{"schemaVersion":3}', 'utf8')

      const result = await readMarketplaceUpdateStates(svc)
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.match(result.message, /install receipt store is invalid/)
    })
  }

  async function testNothingInstalledYieldsNoEntries(): Promise<void> {
    await withTempDir(async (temp) => {
      const svc = services(temp, okRegistry([registryEntry('behind', 2)]))
      const result = await readMarketplaceUpdateStates(svc)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(result.entries, [])
    })
  }

  async function main(): Promise<void> {
    await testReceiptStatesAgainstRegistryLatest()
    await testAnInstallCanBeAheadOfRegistry()
    await testUnreachableRegistryReadsUnknownNeverCurrent()
    await testMalformedReceiptStoreFailsClosed()
    await testNothingInstalledYieldsNoEntries()
    console.log('marketplace update-detection tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
