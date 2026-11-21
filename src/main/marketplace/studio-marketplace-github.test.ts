/**
 * Install a plugin from GitHub, and uninstall it.
 *
 * What only these paths can be wrong about: that a GitHub install needs a
 * token a GitHub review issued (not a registry one, not a spent one), that an
 * update asks again only when the disclosure changed, that uninstall takes out
 * what the receipt says was installed, and that an extension repository is
 * refused with the way to install it instead.
 *
 * The Studio's marketplace runs for real against a scratch data folder and
 * workspace; GitHub is the recorded repository in
 * marketplace/__fixtures__/github-extension-repo.ts.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { MarketplaceRegistryReadResult } from '../../../packages/studio-protocol/src/public'
import type { McpConfigService } from '../mcp-config-service'
import {
  PLUGIN_JSON,
  SHA,
  extensionJsonRepo,
  extensionRepo,
  github,
  type Served,
} from './__fixtures__/github-extension-repo'
import { createStudioMarketplace } from './studio-marketplace'

test('a plugin installed from GitHub, and uninstalled', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'studio-marketplace-github-'))
  const openWorkspace = join(userData, 'workspace')
  mkdirSync(openWorkspace, { recursive: true })

  try {
    // GitHub as it is right now; a test moves the branch by replacing it.
    let repo: Served = github(extensionRepo())
    const registry: MarketplaceRegistryReadResult = {
      ok: true,
      state: 'ok',
      registryUrl: 'https://registry.test/marketplace.json',
      source: 'bundled',
      stale: false,
      fetchedAt: '2026-09-29T00:00:00.000Z',
      marketplace: {
        schemaVersion: 1,
        plugins: [
          {
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
          },
        ],
      },
    }
    const studio = createStudioMarketplace({
      dataDir: () => userData,
      mcpConfig: () => ({ sync: () => ({ ok: true, targets: [] }) }) as unknown as McpConfigService,
      openWorkspaceRoots: () => [openWorkspace],
      registryReader: { read: async () => registry },
      fetcher: (url, init) => repo.fetcher(url, init),
    })
    // ── resolve: only a GitHub URL ───────────────────────────────────────────────
    assert.equal((await studio.resolveGithub('')).ok, false)

    const reviewed = await studio.resolveGithub('https://github.com/acme/notes-ext')
    assert.equal(reviewed.ok, true, reviewed.ok ? '' : reviewed.message)
    if (!reviewed.ok) return
    assert.equal(reviewed.preview.id, 'notes-ext')
    assert.equal(reviewed.preview.verify.classification, 'unsigned')
    assert.equal(reviewed.preview.verify.pin?.commitSha, SHA)
    assert.deepEqual(reviewed.preview.origin, {
      url: 'https://github.com/acme/notes-ext',
      owner: 'acme',
      repo: 'notes-ext',
    })
    assert.equal(reviewed.preview.installed, undefined)

    // ── install: only into a workspace the Studio has open, and once per review
    const outside = await studio.installGithub({
      trustToken: reviewed.trustToken,
      workspaceRoot: join(userData, 'not-open'),
    })
    assert.equal(outside.ok, false)
    assert.match(outside.ok ? '' : outside.message, /Open this workspace/)

    // A registry verify's token does not install here.
    const registryVerify = await studio.verify('inline-mcp-plugin')
    assert.ok(registryVerify.trustToken)
    const crossed = await studio.installGithub({
      trustToken: registryVerify.trustToken ?? '',
      workspaceRoot: openWorkspace,
    })
    assert.equal(crossed.ok, false)

    const installed = await studio.installGithub({ trustToken: reviewed.trustToken, workspaceRoot: openWorkspace })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    const replayed = await studio.installGithub({ trustToken: reviewed.trustToken, workspaceRoot: openWorkspace })
    assert.equal(replayed.ok, false, 'the install spent the token')
    assert.match(replayed.ok ? '' : replayed.message, /expired or was already used/)
    const skillCopy = join(openWorkspace, '.agents', 'skills', 'notes', 'SKILL.md')
    assert.ok(existsSync(skillCopy))

    // ── a review of an installed one says what it changes, and asks again only on change
    const moved = 'b2c3d4e'.padEnd(40, '0')
    repo = github(extensionRepo(), { sha: moved })
    const quiet = await studio.resolveGithub('acme/notes-ext')
    assert.ok(quiet.ok)
    if (quiet.ok) {
      assert.equal(quiet.preview.verify.pin?.commitSha, moved)
      assert.deepEqual(quiet.preview.installed?.changes, [], 'same permissions, servers and signing: no second prompt')
      assert.equal(quiet.preview.installed?.sha, SHA)
    }

    const widened = JSON.stringify({ ...JSON.parse(PLUGIN_JSON), permissions: ['storage', 'network'] })
    repo = github(extensionRepo({ 'plugin.json': widened }), { sha: moved })
    const loud = await studio.resolveGithub('acme/notes-ext')
    assert.ok(loud.ok)
    if (loud.ok) assert.deepEqual(loud.preview.installed?.changes, ['permissions'])

    // ── uninstall: what the receipt installed comes out, and the receipt with it
    const removed = await studio.uninstall({ pluginId: 'notes-ext', workspaceRoot: openWorkspace })
    assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
    assert.deepEqual(removed.ok && removed.removed.map((component) => [component.kind, component.id]), [
      ['skills', 'notes'],
    ])
    assert.equal(existsSync(skillCopy), false)
    const receipts = JSON.parse(readFileSync(join(userData, 'marketplace-plugin-installs.json'), 'utf8'))
    assert.equal(receipts.plugins['notes-ext'], undefined, 'the receipt goes with it')

    // ── an extension repository: not installable from GitHub yet, and says how
    repo = github(extensionJsonRepo())
    const extension = await studio.resolveGithub('acme/notes-ext')
    assert.equal(extension.ok, false)
    assert.match(extension.ok ? '' : extension.message, /installing an extension from GitHub is not available yet/)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
