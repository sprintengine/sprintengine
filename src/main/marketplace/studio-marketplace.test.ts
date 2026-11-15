/**
 * The marketplace as a Studio serves it (`marketplace.*`), at the boundary a
 * client crosses.
 *
 * What only this file can be wrong about is what each call delegates to and
 * what it refuses to take from a client. The lifecycle has its own suite; the
 * protocol's owner rule and the router's once-per-command id have theirs
 * (studio-extensions.test.ts).
 *
 * The client names an entry by id and the Studio resolves it; the only
 * approval is a one-time token the Studio issued at verify; the workspace an
 * install writes into must be one the Studio has open.
 *
 * It runs for real against a scratch data folder, with the registry injected
 * so nothing reaches the network.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { MarketplaceRegistryReadResult } from '../../../packages/studio-protocol/src/public'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import type { McpConfigService } from '../mcp-config-service'
import { createStudioMarketplace } from './studio-marketplace'

const INLINE_ENTRY: MarketplacePluginEntry = {
  id: 'inline-mcp-plugin',
  name: 'Inline MCP Plugin',
  publisher: { name: 'Community Author', verified: false },
  summary: 'Inline MCP server config.',
  category: 'dev-tools',
  icon: 'icons/inline.svg',
  latest: 1,
  provides: ['mcp'],
  mcp: {
    servers: [
      {
        id: 'inline-mcp',
        name: 'inline-mcp',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        clients: ['codex'],
        scope: 'workspace',
        source: 'custom',
        enabled: true,
        riskLevel: 'local-command',
      },
    ],
  },
}

let dataDir = ''
let openWorkspace = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'studio-marketplace-'))
  openWorkspace = join(dataDir, 'workspace')
  mkdirSync(openWorkspace, { recursive: true })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function marketplace() {
  const registry: MarketplaceRegistryReadResult = {
    ok: true,
    state: 'ok',
    registryUrl: 'https://registry.test/marketplace.json',
    source: 'bundled',
    stale: false,
    fetchedAt: '2026-09-29T00:00:00.000Z',
    marketplace: { schemaVersion: 1, plugins: [INLINE_ENTRY] },
  }
  const synced: unknown[] = []
  let changed = 0
  const studio = createStudioMarketplace({
    dataDir: () => dataDir,
    mcpConfig: () =>
      ({
        sync: (input: unknown) => {
          synced.push(input)
          return { ok: true, targets: [] }
        },
      }) as unknown as McpConfigService,
    openWorkspaceRoots: () => [openWorkspace],
    changed: () => void changed++,
    registryReader: { read: async () => registry },
  })
  return { studio, synced, changed: () => changed }
}

test('verify resolves the entry here and issues the only approval', async () => {
  const { studio } = marketplace()
  const verified = await studio.verify(INLINE_ENTRY.id)
  assert.equal(verified.classification, 'unsigned')
  assert.deepEqual(verified.mcpServers?.[0]?.args, ['server.js'])
  assert.equal(typeof verified.trustToken, 'string')

  const unknown = await studio.verify('not-listed')
  assert.equal(unknown.classification, 'invalid')
  assert.match(unknown.message ?? '', /not in the marketplace/)
  assert.equal(unknown.trustToken, undefined)
})

test('an install needs the approval its review issued, spends it once, and writes only into an open workspace', async () => {
  const { studio, synced } = marketplace()
  const verified = await studio.verify(INLINE_ENTRY.id)

  const noToken = await studio.install({ id: INLINE_ENTRY.id, workspaceRoot: openWorkspace })
  assert.equal(noToken.ok, false)
  if (!noToken.ok) assert.match(noToken.message, /requires trust approval/)

  const forged = await studio.install({ id: INLINE_ENTRY.id, workspaceRoot: openWorkspace, trustToken: 'forged' })
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.match(forged.message, /expired or was already used/)

  const elsewhere = await studio.install({
    id: INLINE_ENTRY.id,
    workspaceRoot: join(dataDir, 'not-open'),
    ...(verified.trustToken ? { trustToken: verified.trustToken } : {}),
  })
  assert.equal(elsewhere.ok, false)
  if (!elsewhere.ok) assert.match(elsewhere.message, /Open this workspace/)
  assert.equal(synced.length, 0, 'nothing was written for any refusal')

  const again = await studio.verify(INLINE_ENTRY.id)
  const installed = await studio.install({
    id: INLINE_ENTRY.id,
    workspaceRoot: openWorkspace,
    mcpSettings: { syncEnabled: false, servers: {} },
    ...(again.trustToken ? { trustToken: again.trustToken } : {}),
  })
  assert.equal(installed.ok, true, JSON.stringify(installed))
  assert.equal(synced.length, 1)
  const replayed = await studio.install({
    id: INLINE_ENTRY.id,
    workspaceRoot: openWorkspace,
    ...(again.trustToken ? { trustToken: again.trustToken } : {}),
  })
  assert.equal(replayed.ok, false, 'a token is spent by the install it approved')
})

test('uninstall delegates to the lifecycle, and says so in words when there is nothing to remove', async () => {
  const { studio } = marketplace()
  const missing = await studio.uninstall({ pluginId: 'never-installed' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.message, /never-installed is not installed/)

  const verified = await studio.verify(INLINE_ENTRY.id)
  const installed = await studio.install({
    id: INLINE_ENTRY.id,
    workspaceRoot: openWorkspace,
    ...(verified.trustToken ? { trustToken: verified.trustToken } : {}),
  })
  assert.equal(installed.ok, true, JSON.stringify(installed))
  const removed = await studio.uninstall({ pluginId: INLINE_ENTRY.id, workspaceRoot: openWorkspace })
  assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
})

test('a registry that cannot be read is answered in the read’s own shape', async () => {
  const studio = createStudioMarketplace({
    dataDir: () => dataDir,
    mcpConfig: () => ({}) as McpConfigService,
    openWorkspaceRoots: () => [],
    registryReader: {
      read: async () => {
        throw new Error('socket hang up')
      },
    },
  })
  const read = await studio.read()
  assert.equal(read.ok, false)
  if (!read.ok) assert.equal(read.state, 'fetch-error')
  const verify = await studio.verify(INLINE_ENTRY.id)
  assert.equal(verify.classification, 'invalid')
})
