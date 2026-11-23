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
 * so nothing reaches the network. The entry is a Claude Code plugin whose
 * skills this checkout does not bundle, so a review answers honestly that
 * there is nothing to install and an approved install reaches the lifecycle
 * and stops there.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import type { MarketplaceRegistryReadResult } from '../../../packages/studio-protocol/src/public'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { createStudioMarketplace } from './studio-marketplace'
import { issueTrustToken } from './trust-tokens'

const CLAUDE_ENTRY: MarketplacePluginEntry = {
  id: 'acme-review-skills',
  name: 'Review skills',
  publisher: { name: 'Acme', verified: false },
  summary: 'Review skills for Claude Code.',
  category: 'dev-tools',
  icon: 'icons/review.svg',
  latest: 1,
  provides: ['skills'],
  tags: ['claude-plugin'],
  source: 'https://github.com/acme/review-skills',
  skills: [{ name: 'review', description: 'Reviews a change.' }],
}

const PIN = { manifestSha256: 'a'.repeat(64), componentDigests: { 'skills/review': 'b'.repeat(64) } }

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
    marketplace: { schemaVersion: 1, plugins: [CLAUDE_ENTRY] },
  }
  let changed = 0
  const studio = createStudioMarketplace({
    dataDir: () => dataDir,
    openWorkspaceRoots: () => [openWorkspace],
    changed: () => void changed++,
    registryReader: { read: async () => registry },
  })
  return { studio, changed: () => changed }
}

test('verify resolves the entry here, and issues no approval for what it cannot disclose', async () => {
  const { studio } = marketplace()
  const unbundled = await studio.verify(CLAUDE_ENTRY.id)
  assert.equal(unbundled.classification, 'invalid')
  assert.match(unbundled.message ?? '', /isn’t installable offline yet/)
  assert.equal(unbundled.trustToken, undefined)
  assert.equal(unbundled.pin, undefined)

  const unknown = await studio.verify('not-listed')
  assert.equal(unknown.classification, 'invalid')
  assert.match(unknown.message ?? '', /not in the marketplace/)
  assert.equal(unknown.trustToken, undefined)
})

test('an install needs the approval its review issued, spends it once, and writes only into an open workspace', async () => {
  const { studio, changed } = marketplace()

  const noToken = await studio.install({ id: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace })
  assert.equal(noToken.ok, false)
  if (!noToken.ok) assert.match(noToken.message, /requires trust approval/)

  const forged = await studio.install({ id: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace, trustToken: 'forged' })
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.match(forged.message, /expired or was already used/)

  const elsewhere = await studio.install({
    id: CLAUDE_ENTRY.id,
    workspaceRoot: join(dataDir, 'not-open'),
    trustToken: issueTrustToken({ entryId: CLAUDE_ENTRY.id, pin: PIN, entry: CLAUDE_ENTRY }),
  })
  assert.equal(elsewhere.ok, false)
  if (!elsewhere.ok) assert.match(elsewhere.message, /Open this workspace/)

  // A token issued for another entry is refused, and burned.
  const otherToken = issueTrustToken({ entryId: 'someone-else', pin: PIN, entry: CLAUDE_ENTRY })
  const crossed = await studio.install({ id: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace, trustToken: otherToken })
  assert.equal(crossed.ok, false)
  if (!crossed.ok) assert.match(crossed.message, /expired or was already used/)

  // An approved install reaches the lifecycle, which stages the bundled
  // skills; none ship in this checkout, so it says so and writes nothing.
  const token = issueTrustToken({ entryId: CLAUDE_ENTRY.id, pin: PIN, entry: CLAUDE_ENTRY })
  const attempted = await studio.install({ id: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace, trustToken: token })
  assert.equal(attempted.ok, false)
  if (!attempted.ok) assert.match(attempted.message, /isn’t installable offline yet/)
  assert.equal(existsSync(join(openWorkspace, '.claude')), false, 'nothing was written for any refusal')
  assert.equal(changed(), 0)

  const replayed = await studio.install({ id: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace, trustToken: token })
  assert.equal(replayed.ok, false, 'a token is spent by the install it approved')
  if (!replayed.ok) assert.match(replayed.message, /expired or was already used/)
})

test('uninstall delegates to the lifecycle, and says so in words when there is nothing to remove', async () => {
  const { studio, changed } = marketplace()
  const missing = await studio.uninstall({ pluginId: 'never-installed' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.message, /never-installed is not installed/)

  // A receipt the lifecycle wrote, and the skill copy it records.
  const skillDir = join(openWorkspace, '.claude', 'skills', 'review')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\n---\n', 'utf8')
  writeFileSync(
    join(dataDir, 'marketplace-plugin-installs.json'),
    JSON.stringify({
      schemaVersion: 2,
      plugins: {
        [CLAUDE_ENTRY.id]: {
          id: CLAUDE_ENTRY.id,
          displayName: CLAUDE_ENTRY.name,
          version: 1,
          sourceUrl: CLAUDE_ENTRY.source,
          classification: 'unsigned',
          installedAt: '2026-09-29T00:00:00.000Z',
          components: [{ kind: 'skills', id: 'review', installedDirName: 'review', harnesses: ['claude'] }],
        },
      },
    }),
    'utf8',
  )
  const elsewhere = await studio.uninstall({ pluginId: CLAUDE_ENTRY.id, workspaceRoot: join(dataDir, 'not-open') })
  assert.equal(elsewhere.ok, false)
  assert.equal(existsSync(skillDir), true)

  const removed = await studio.uninstall({ pluginId: CLAUDE_ENTRY.id, workspaceRoot: openWorkspace })
  assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
  assert.equal(existsSync(skillDir), false)
  assert.equal(changed(), 1)
})

test('a registry that cannot be read is answered in the read’s own shape', async () => {
  const studio = createStudioMarketplace({
    dataDir: () => dataDir,
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
  const verify = await studio.verify(CLAUDE_ENTRY.id)
  assert.equal(verify.classification, 'invalid')
})
