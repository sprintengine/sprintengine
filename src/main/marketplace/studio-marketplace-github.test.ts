/**
 * Install extension from GitHub, and uninstall it however it arrived.
 *
 * What only these paths can be wrong about: that a GitHub install needs a
 * token a GitHub review issued (not a registry one, not a spent one), that
 * unsigned code needs the person's own "I trust this code", that an update
 * asks again only when the disclosure changed, and that uninstall removes a
 * module however it arrived — through its plugin's own uninstall when a
 * receipt owns it (the Studio's `module.uninstall` refuses it, naming the
 * plugin), by its folder (and only that folder) when not — and forgets its
 * trust, enablement choice and secrets with it.
 *
 * The Studio's marketplace runs for real against a scratch data folder and
 * module root; GitHub
 * is the recorded repository in marketplace/__fixtures__/github-extension-repo.ts.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { MarketplaceRegistryReadResult } from '../../../packages/studio-protocol/src/public'
import type { McpConfigService } from '../mcp-config-service'
import { PLUGIN_JSON, SHA, extensionRepo, github, type Served } from './__fixtures__/github-extension-repo'
import { createStudioMarketplace } from './studio-marketplace'

test('an extension installed from GitHub, and uninstalled however it arrived', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'studio-marketplace-github-'))
  const moduleRoot = join(userData, 'modules')
  const openWorkspace = join(userData, 'workspace')
  mkdirSync(openWorkspace, { recursive: true })
  process.env.SPRINTENGINE_USER_DATA_DIR = userData
  process.env.SPRINTENGINE_USER_MODULE_ROOT = moduleRoot

  try {
    const { createModuleLifecycle } = await import('../modules/module-lifecycle')
    const { readTrustedModulesSync, setModuleTrust } = await import('../modules/trust-store')
    const { readModuleOverridesSync, writeModuleOverrides } = await import('../module-host/enablement-store')

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
    const lifecycle = createModuleLifecycle({
      dataDir: userData,
      moduleRoot: () => moduleRoot,
      view: () => null,
      applyEnablement: async () => ({ ok: true }),
      changed: () => undefined,
      launchSession: () => ({
        snapshot: { loaded: new Set(), manifestOnly: new Set(), errors: new Map() },
        mcpTools: new Map(),
      }),
      registry: { write: () => ({ ok: true }) },
    })

    // ── resolve: only a GitHub URL ───────────────────────────────────────────────
    assert.equal((await studio.resolveGithub('')).ok, false)

    const reviewed = await studio.resolveGithub('https://github.com/acme/notes-ext')
    assert.equal(reviewed.ok, true, reviewed.ok ? '' : reviewed.message)
    if (!reviewed.ok) return
    assert.equal(reviewed.preview.id, 'notes-ext')
    assert.equal(reviewed.preview.verify.classification, 'unsigned')
    assert.equal(reviewed.preview.verify.codeBearing, true)
    assert.equal(reviewed.preview.verify.pin?.commitSha, SHA)
    assert.deepEqual(reviewed.preview.origin, {
      url: 'https://github.com/acme/notes-ext',
      owner: 'acme',
      repo: 'notes-ext',
    })
    assert.equal(reviewed.preview.installed, undefined)

    // ── install: unsigned code needs "I trust this code", and the token is spent
    const unconfirmed = await studio.installGithub({ trustToken: reviewed.trustToken })
    assert.equal(unconfirmed.ok, false)
    assert.match(unconfirmed.ok ? '' : unconfirmed.message, /confirm you trust the code/)
    const replayed = await studio.installGithub({ trustToken: reviewed.trustToken, trustCode: true })
    assert.equal(replayed.ok, false, 'the refused request spent the token')
    assert.match(replayed.ok ? '' : replayed.message, /expired or was already used/)

    // A registry verify's token does not install here.
    const registryVerify = await studio.verify('inline-mcp-plugin')
    assert.ok(registryVerify.trustToken)
    const crossed = await studio.installGithub({ trustToken: registryVerify.trustToken ?? '', trustCode: true })
    assert.equal(crossed.ok, false)

    const again = await studio.resolveGithub('acme/notes-ext')
    assert.ok(again.ok)
    const installed = await studio.installGithub({ trustToken: again.trustToken, trustCode: true })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    assert.ok(existsSync(join(moduleRoot, 'notes-ext', 'manifest.json')))
    assert.ok(readTrustedModulesSync(userData).has('notes-ext'), 'the review was the trust decision')

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

    // ── uninstall: a receipt-owned module goes out through its plugin ──────────
    await writeModuleOverrides(userData, { 'notes-ext': true })
    const owned = await lifecycle.uninstall('notes-ext')
    assert.equal(owned.ok, false)
    assert.equal(!owned.ok && owned.pluginId, 'notes-ext', 'the Studio names the plugin that owns it')
    assert.ok(existsSync(join(moduleRoot, 'notes-ext')), 'and leaves it to that plugin')
    const removed = await studio.uninstall({ pluginId: 'notes-ext' })
    assert.equal(removed.ok, true, removed.ok ? '' : removed.message)
    assert.deepEqual(
      removed.ok && removed.removed.filter((component) => component.kind === 'module').map((component) => component.id),
      ['notes-ext'],
    )
    assert.equal(existsSync(join(moduleRoot, 'notes-ext')), false)
    assert.equal(readTrustedModulesSync(userData).has('notes-ext'), false)
    assert.equal('notes-ext' in readModuleOverridesSync(userData), false)
    const receipts = JSON.parse(readFileSync(join(userData, 'marketplace-plugin-installs.json'), 'utf8'))
    assert.equal(receipts.plugins['notes-ext'], undefined, 'the receipt goes with it')

    // ── uninstall: a folder-installed module, with everything kept about it ─────
    const folder = join(moduleRoot, 'folder-mod')
    mkdirSync(join(folder, 'dist'), { recursive: true })
    writeFileSync(join(folder, 'dist', 'renderer.mjs'), 'export default () => {}\n')
    writeFileSync(
      join(folder, 'manifest.json'),
      JSON.stringify({
        id: 'folder-mod',
        displayName: 'Folder module',
        version: 1,
        defaultEnabled: false,
        source: 'third-party',
        engines: { hostApi: 2 },
        entry: { renderer: 'dist/renderer.mjs' },
      }),
    )
    await setModuleTrust(userData, 'folder-mod', 'f'.repeat(64))
    await writeModuleOverrides(userData, { 'folder-mod': true, 'other-mod': false })
    const secrets = join(userData, 'module-secrets', 'folder-mod.bin')
    mkdirSync(join(userData, 'module-secrets'), { recursive: true })
    writeFileSync(secrets, 'sealed')
    // A sibling outside the module root must survive whatever id is asked for.
    const outside = join(userData, 'outside')
    mkdirSync(outside, { recursive: true })

    for (const id of ['', '..', '../outside', 'a/b']) {
      const refused = await lifecycle.uninstall(id)
      assert.equal(refused.ok, false, `"${id}" is not a module id`)
    }
    const unknown = await lifecycle.uninstall('never-installed')
    assert.match(unknown.ok ? '' : unknown.message, /is not installed/)

    const folderRemoved = await lifecycle.uninstall('folder-mod')
    assert.equal(folderRemoved.ok, true, folderRemoved.ok ? '' : folderRemoved.message)
    assert.equal(existsSync(folder), false)
    assert.ok(existsSync(outside))
    assert.ok(existsSync(moduleRoot), 'the module root itself stays')
    assert.equal(readTrustedModulesSync(userData).has('folder-mod'), false)
    assert.deepEqual(readModuleOverridesSync(userData), { 'other-mod': false })
    assert.equal(existsSync(secrets), false, 'a later module with this id inherits no secrets')
  } finally {
    delete process.env.SPRINTENGINE_USER_MODULE_ROOT
    rmSync(userData, { recursive: true, force: true })
  }
})
