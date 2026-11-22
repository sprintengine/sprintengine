import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SkillHarness } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { createMarketplacePluginLifecycleService, type MarketplacePluginLifecycleServices } from './plugin-lifecycle'
import { createMarketplacePluginVerifier } from './plugin-verify'
import type { TrustGrant } from './trust-tokens'
import { MarketplaceRegistryClient, configuredMarketplaceRegistryUrl } from './registry-client'
import { skillContentDigest } from './skill-content'
import { readMarketplaceUpdateStates } from './update-detection'
import { test } from 'vitest'

test('plugin-lifecycle', async () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-lifecycle-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // What the storefront's verify hands the install: the grant the person's
  // approval produces, pinned to exactly what the real verifier read. An entry
  // verify refuses gets a pin that matches nothing, so the install's own gate
  // is what the test sees.
  async function approve(
    services: MarketplacePluginLifecycleServices,
    entry: MarketplacePluginEntry,
  ): Promise<TrustGrant> {
    const verified = await createMarketplacePluginVerifier({
      stagingRoot: services.stagingRoot,
      packagedResourceResolver: services.packagedResourceResolver,
    }).verify(entry)
    return {
      entryId: entry.id,
      entry,
      pin: verified.pin ?? { manifestSha256: 'unverified', componentDigests: {} },
    }
  }

  async function createServices(temp: string): Promise<{
    services: MarketplacePluginLifecycleServices
    workspaceRoot: string
    receiptStorePath: string
  }> {
    const workspaceRoot = join(temp, 'workspace')
    const receiptStorePath = join(temp, 'marketplace-installs.json')
    await mkdir(workspaceRoot, { recursive: true })
    return {
      workspaceRoot,
      receiptStorePath,
      services: { receiptStorePath, stagingRoot: join(temp, 'staging') },
    }
  }

  // --- Claude Code plugin installs (bundled snapshot content) -----------------

  const CLAUDE_SKILL_BODIES: Record<string, string> = {
    alpha: '---\nname: alpha\ndescription: First.\n---\n',
    beta: '---\nname: beta\ndescription: Second.\n---\n',
  }

  function claudeSkillDigest(body: string): { path: string; sha256: string; size: number } {
    return {
      path: 'SKILL.md',
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      size: Buffer.byteLength(body, 'utf8'),
    }
  }

  const CLAUDE_LIFECYCLE_ENTRY: MarketplacePluginEntry = {
    id: 'acme-skills',
    name: 'skills',
    publisher: { name: 'Acme', verified: false },
    summary: 'Acme skills plugin.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    provides: ['skills'],
    tags: ['claude-plugin'],
    source: 'https://github.com/acme/skills',
    skills: Object.entries(CLAUDE_SKILL_BODIES).map(([folder, body]) => {
      const files = [claudeSkillDigest(body)]
      return {
        name: folder,
        description: `The ${folder} skill.`,
        path: `skills/${folder}`,
        files,
        contentDigest: skillContentDigest(files),
      }
    }),
  }

  // Writes the packaged payload dir the catalogue generator would emit and
  // returns the resolver the download resolves it through.
  async function installClaudePayload(temp: string): Promise<(relativePath: string) => string | null> {
    const resourceDir = join(temp, 'packaged', 'skills', 'acme-skills')
    for (const [folder, body] of Object.entries(CLAUDE_SKILL_BODIES)) {
      await mkdir(join(resourceDir, folder), { recursive: true })
      await writeFile(join(resourceDir, folder, 'SKILL.md'), body, 'utf8')
    }
    return (relativePath) => (relativePath === 'skills/acme-skills' ? resourceDir : null)
  }

  async function testClaudePluginRequiresTrustGrant(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({ entry: CLAUDE_LIFECYCLE_ENTRY, workspaceRoot })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.classification, 'unsigned')
        assert.match(result.message, /trust approval/)
      }
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
    })
  }

  async function testClaudePluginInstallsSkillsIntoClaudeHarnessAndUninstalls(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) return
      assert.equal(result.classification, 'unsigned')
      // With no resolveSkillHarnesses wired (these services), installs fall
      // back to the Claude harness dir only — never a silent no-op.
      assert.equal(
        await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
        '---\nname: alpha\ndescription: First.\n---\n',
      )
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta', 'SKILL.md')), true)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)

      const store = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<
          string,
          { components: Array<{ kind: string; installedDirName?: string; harnesses?: string[] }> }
        >
      }
      const receipt = store.plugins['acme-skills']
      assert.ok(receipt, 'receipt written')
      assert.deepEqual(
        receipt.components.map((component) => `${component.kind}:${component.installedDirName}`),
        ['skills:alpha', 'skills:beta'],
      )
      assert.deepEqual(receipt.components[0]!.harnesses, ['claude'])

      const removed = await lifecycle.uninstall({ pluginId: 'acme-skills', workspaceRoot })
      assert.equal(removed.ok, true, JSON.stringify(removed))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta')), false)
    })
  }

  async function testClaudePluginDefaultFanOutUsesResolvedHarnesses(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      // The wired resolver (installed CLIs with native skill support + agents)
      // drives the default target set; the caller passes no skillHarnesses.
      services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'codex', 'agents'])
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha', 'SKILL.md')), true, `alpha lands in ${dir}`)
      }
      // No writes outside the resolved set.
      assert.equal(existsSync(join(workspaceRoot, '.cursor', 'skills', 'alpha')), false)

      const store = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<string, { components: Array<{ harnesses?: string[] }> }>
      }
      assert.deepEqual(store.plugins['acme-skills']!.components[0]!.harnesses, ['claude', 'codex', 'agents'])

      // Uninstall removes every harness copy the receipt recorded.
      const removed = await lifecycle.uninstall({ pluginId: 'acme-skills', workspaceRoot })
      assert.equal(removed.ok, true, JSON.stringify(removed))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(existsSync(join(workspaceRoot, dir, 'skills', 'alpha')), false, `alpha removed from ${dir}`)
      }
    })
  }

  async function testClaudePluginAutoResolveUpdateNeverDeletesOnProbeHiccup(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      // First auto-resolved install lands claude+codex+agents.
      services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'codex', 'agents'])
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const first = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(
          existsSync(join(workspaceRoot, dir, 'skills', 'alpha')),
          true,
          `alpha in ${dir} after first install`,
        )
      }

      // Update while the codex probe transiently reports not-installed: the
      // resolved set narrows to claude+agents. Auto-resolution must NOT delete
      // the still-wanted .codex copies — union with the prior receipt keeps them.
      services.resolveSkillHarnesses = () => Promise.resolve(['claude', 'agents'])
      const update = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(update.ok, true, JSON.stringify(update))
      for (const dir of ['.claude', '.codex', '.agents']) {
        assert.equal(
          existsSync(join(workspaceRoot, dir, 'skills', 'alpha')),
          true,
          `alpha preserved in ${dir} after probe hiccup`,
        )
      }
    })
  }

  async function testClaudePluginExplicitHarnessNarrowingStillRemoves(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const first = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
        skillHarnesses: ['claude', 'codex', 'agents'],
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      // An EXPLICIT narrowing is a deliberate intent — the .codex copies go.
      const update = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
        skillHarnesses: ['claude'],
      })
      assert.equal(update.ok, true, JSON.stringify(update))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
      assert.equal(existsSync(join(workspaceRoot, '.codex', 'skills', 'alpha')), false)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
    })
  }

  async function testClaudePluginResolverFailureFallsBackToClaude(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      services.resolveSkillHarnesses = () => Promise.reject(new Error('probe blew up'))
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
    })

    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      // An empty resolved set must not install nowhere while claiming success.
      services.resolveSkillHarnesses = () => Promise.resolve([])
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
    })
  }

  async function testClaudePluginHarnessChangeRemovesOrphanedCopies(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      // First install targets claude + agents.
      const first = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
        skillHarnesses: ['claude', 'agents'],
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), true)
      // Update narrows to claude only: the .agents copies must be removed, not
      // stranded untracked (componentsOverlap keys skills on dir name alone).
      const second = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
        skillHarnesses: ['claude'],
      })
      assert.equal(second.ok, true, JSON.stringify(second))
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'beta')), false)
    })
  }

  async function testClaudePluginRefusesForeignSkillDirCollision(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      // A hand-dropped skill dir this plugin does not own.
      await mkdir(join(workspaceRoot, '.claude', 'skills', 'alpha'), { recursive: true })
      await writeFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'mine, not yours', 'utf8')
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /already exists/)
      // The pre-flight refusal copies nothing and never clobbers the existing dir.
      assert.equal(
        await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
        'mine, not yours',
      )
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta')), false)
    })
  }

  // The marketplace installs Claude Code plugins and nothing else: an agent
  // CLI row ships with the app, and a plugin bundle or an inline MCP row no
  // longer exists.
  async function testNonClaudeEntryIsRefused(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const cliRow: MarketplacePluginEntry = {
        id: 'claude-code',
        name: 'Claude Code',
        publisher: { name: 'Anthropic', verified: true },
        summary: 'An agent CLI the app ships.',
        category: 'Agents',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        latest: 1,
        provides: ['cli'],
        cli: { pluginId: 'claude-code' },
      }
      const result = await lifecycle.install({ entry: cliRow, workspaceRoot })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /is not a Claude Code plugin/)
      assert.equal(existsSync(receiptStorePath), false)
    })
  }

  // An approval for another entry is no approval at all.
  async function testGrantForAnotherEntryIsRefused(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const grant = await approve(services, CLAUDE_LIFECYCLE_ENTRY)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: { ...grant, entryId: 'another-plugin' },
      })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /different extension/)
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
    })
  }

  // The install is bound to what the prompt showed. The bundled content
  // changes after the approval (an app or catalogue update) and the install
  // refuses rather than writing skills nobody reviewed.
  async function testInstallRefusesContentThatChangedAfterApproval(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const grant = await approve(services, CLAUDE_LIFECYCLE_ENTRY)

      const changed = '---\nname: alpha\ndescription: Changed.\n---\n'
      await writeFile(join(temp, 'packaged', 'skills', 'acme-skills', 'alpha', 'SKILL.md'), changed, 'utf8')
      const files = [claudeSkillDigest(changed)]
      const updatedEntry: MarketplacePluginEntry = {
        ...CLAUDE_LIFECYCLE_ENTRY,
        skills: CLAUDE_LIFECYCLE_ENTRY.skills!.map((skill) =>
          skill.name === 'alpha' ? { ...skill, files, contentDigest: skillContentDigest(files) } : skill,
        ),
      }
      const result = await lifecycle.install({ entry: updatedEntry, workspaceRoot, grant })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /changed after you reviewed it/)
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
      assert.equal(existsSync(receiptStorePath), false)
    })
  }

  // An update never goes backwards, whatever the registry lists.
  async function testUpdateRefusesAnOlderVersion(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const v2 = { ...CLAUDE_LIFECYCLE_ENTRY, latest: 2 }
      const installed = await lifecycle.install({ entry: v2, workspaceRoot, grant: await approve(services, v2) })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      const rolledBack = await lifecycle.update({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(rolledBack.ok, false)
      if (rolledBack.ok) return
      assert.match(rolledBack.message, /version 1 is older than the installed version 2/)
      const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<string, { version?: unknown }>
      }
      assert.equal(receipts.plugins['acme-skills']?.version, 2)
    })
  }

  // A copy that fails part-way is rolled back: the harness copies already
  // written go, and no receipt is left claiming them.
  async function testFailedCopyRollsBackResidue(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      // Nothing can be written into the agents harness dir.
      const agentsSkills = join(workspaceRoot, '.agents', 'skills')
      await mkdir(agentsSkills, { recursive: true })
      await chmod(agentsSkills, 0o500)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      try {
        const result = await lifecycle.install({
          entry: CLAUDE_LIFECYCLE_ENTRY,
          workspaceRoot,
          skillHarnesses: ['claude', 'agents'],
          grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
        })
        assert.equal(result.ok, false, JSON.stringify(result))
        if (result.ok) return
        assert.match(result.message, /Could not copy plugin skill "alpha"/)
        assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), false)
        assert.equal(existsSync(receiptStorePath), false)
      } finally {
        await chmod(agentsSkills, 0o700)
      }
    })
  }

  // An update that fails after the copy it replaces was removed puts the
  // previous install back, and keeps its receipt.
  async function testFailedUpdateRestoresThePreviousInstallAndKeepsReceipt(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const installed = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        skillHarnesses: ['claude'],
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      const agentsSkills = join(workspaceRoot, '.agents', 'skills')
      await mkdir(agentsSkills, { recursive: true })
      await chmod(agentsSkills, 0o500)
      const v2 = { ...CLAUDE_LIFECYCLE_ENTRY, latest: 2 }
      try {
        const updated = await lifecycle.update({
          entry: v2,
          workspaceRoot,
          skillHarnesses: ['claude', 'agents'],
          grant: await approve(services, v2),
        })
        assert.equal(updated.ok, false)
        if (updated.ok) return
        assert.equal(updated.updated, true)
      } finally {
        await chmod(agentsSkills, 0o700)
      }
      assert.equal(
        await readFile(join(workspaceRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
        CLAUDE_SKILL_BODIES.alpha,
      )
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'beta', 'SKILL.md')), true)
      const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        plugins: Record<string, { version?: unknown }>
      }
      assert.equal(receipts.plugins['acme-skills']?.version, 1)
    })
  }

  // A receipt that cannot be written undoes the install: nothing the plugin
  // added is left behind without a receipt to remove it by.
  async function testFailedReceiptWriteRollsBackTheInstall(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)

      // Make only the receipt write fail: the store file is missing (an empty
      // store, as on a first install) inside a directory nothing may write to.
      const receiptDir = join(temp, 'read-only-receipts')
      await mkdir(receiptDir, { recursive: true })
      services.receiptStorePath = join(receiptDir, 'marketplace-installs.json')
      const grant = await approve(services, CLAUDE_LIFECYCLE_ENTRY)
      await chmod(receiptDir, 0o500)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      try {
        const result = await lifecycle.install({
          entry: CLAUDE_LIFECYCLE_ENTRY,
          workspaceRoot,
          skillHarnesses: ['agents'],
          grant,
        })
        assert.equal(result.ok, false, JSON.stringify(result))
        if (result.ok) return
        assert.match(result.message, /Could not write marketplace plugin install receipt/)
        assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha')), false)
        assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'beta')), false)
      } finally {
        await chmod(receiptDir, 0o700)
      }
    })
  }

  // A receipt names only skill copies. One that names any other kind (an MCP
  // server, which a plugin bundle once installed) is not one this Studio
  // wrote: the store is refused, never skipped, and nothing is touched.
  async function testReceiptWithAnUnsupportedComponentKindIsRejected(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const installed = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      const receipts = JSON.parse(await readFile(receiptStorePath, 'utf8')) as {
        schemaVersion: number
        plugins: Record<string, { components: Array<Record<string, unknown>> }>
      }
      assert.equal(receipts.schemaVersion, 2)
      receipts.plugins['acme-skills']?.components.push({ kind: 'mcp', id: 'old-server', serverIds: ['old-server'] })
      await writeFile(receiptStorePath, `${JSON.stringify(receipts, null, 2)}\n`, 'utf8')

      const uninstalled = await lifecycle.uninstall({ pluginId: 'acme-skills', workspaceRoot })
      assert.equal(uninstalled.ok, false)
      if (!uninstalled.ok) assert.match(uninstalled.message, /components\[2\]\.kind: unsupported component kind/)
      assert.equal(existsSync(join(workspaceRoot, '.claude', 'skills', 'alpha')), true, 'nothing is removed')
    })
  }

  // With the registry override serving latest=2 over an installed v1, the
  // update state reads update-available, the update runs, and the state
  // settles to current in the same process — no restart.
  async function testUpdateAvailabilitySettlesThroughRegistryUpdate(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const installed = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(installed.ok, true, JSON.stringify(installed))

      const v2 = { ...CLAUDE_LIFECYCLE_ENTRY, latest: 2 }
      // The registry override env var is the fixture seam: the client reads the
      // configured URL, which serves an index whose latest is 2.
      const registryUrl = configuredMarketplaceRegistryUrl({
        SPRINTENGINE_MARKETPLACE_REGISTRY_URL: 'https://registry.test/marketplace.json',
      } as unknown as NodeJS.ProcessEnv)
      assert.equal(registryUrl, 'https://registry.test/marketplace.json')
      const registryReader = new MarketplaceRegistryClient({
        registryUrl,
        cachePath: join(temp, 'registry-cache.json'),
        usePackagedSeedFallback: false,
        fetcher: async (url) =>
          url === registryUrl
            ? new Response(JSON.stringify({ schemaVersion: 1, plugins: [v2] }))
            : new Response('not found', { status: 404 }),
      })
      const updateStateServices = { registryReader, receiptStorePath }

      const before = await readMarketplaceUpdateStates(updateStateServices)
      assert.equal(before.ok && before.checked, true)
      if (!before.ok || !before.checked) return
      assert.deepEqual(before.entries, [
        {
          id: 'acme-skills',
          displayName: 'skills',
          availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
        },
      ])

      const updated = await lifecycle.update({ entry: v2, workspaceRoot, grant: await approve(services, v2) })
      assert.equal(updated.ok, true, JSON.stringify(updated))
      if (!updated.ok) return
      assert.equal(updated.updated, true)

      const after = await readMarketplaceUpdateStates(updateStateServices)
      assert.equal(after.ok && after.checked, true)
      if (!after.ok || !after.checked) return
      assert.deepEqual(after.entries[0]?.availability, { state: 'current', installedVersion: 2, latestVersion: 2 })
    })
  }

  // M-F7: a harness is one of the app's own skill dirs, never a path segment
  // the caller made up.
  async function testUnknownSkillHarnessesWriteNothing(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot } = await createServices(temp)
      services.packagedResourceResolver = await installClaudePayload(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)
      const result = await lifecycle.install({
        entry: CLAUDE_LIFECYCLE_ENTRY,
        workspaceRoot,
        skillHarnesses: ['./../../escaped' as SkillHarness, 'agents'],
        grant: await approve(services, CLAUDE_LIFECYCLE_ENTRY),
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(existsSync(join(workspaceRoot, '.agents', 'skills', 'alpha', 'SKILL.md')), true)
      assert.equal(existsSync(join(temp, 'escaped')), false)
      assert.equal(existsSync(join(workspaceRoot, '.', '..', '..', 'escaped')), false)
    })
  }

  async function testReceiptStoreValidationRejectsMalformedAndUnsafeState(): Promise<void> {
    await withTempDir(async (temp) => {
      const { services, workspaceRoot, receiptStorePath } = await createServices(temp)
      const lifecycle = createMarketplacePluginLifecycleService(services)

      await mkdir(dirname(receiptStorePath), { recursive: true })
      await writeFile(receiptStorePath, '{ not json', 'utf8')
      const malformed = await lifecycle.uninstall({
        pluginId: 'registry-plugin',
        workspaceRoot,
      })
      assert.equal(malformed.ok, false)
      assert.match(malformed.message, /receipt store is invalid/)

      const outsidePath = join(workspaceRoot, '.agents', 'outside')
      await mkdir(outsidePath, { recursive: true })
      await writeFile(
        receiptStorePath,
        `${JSON.stringify(
          {
            schemaVersion: 2,
            plugins: {
              'registry-plugin': {
                id: 'registry-plugin',
                displayName: 'Registry Plugin',
                version: 1,
                sourceUrl: 'https://example.test/registry-plugin',
                classification: 'unsigned',
                installedAt: new Date().toISOString(),
                components: [{ kind: 'skills', id: '../outside' }],
              },
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const unsafe = await lifecycle.uninstall({
        pluginId: 'registry-plugin',
        workspaceRoot,
      })
      assert.equal(unsafe.ok, false)
      assert.match(unsafe.message, /components\[0\]\.id/)
      assert.equal(existsSync(outsidePath), true)
    })
  }

  async function main(): Promise<void> {
    await testNonClaudeEntryIsRefused()
    await testGrantForAnotherEntryIsRefused()
    await testInstallRefusesContentThatChangedAfterApproval()
    await testUpdateRefusesAnOlderVersion()
    await testUnknownSkillHarnessesWriteNothing()
    await testFailedCopyRollsBackResidue()
    await testFailedUpdateRestoresThePreviousInstallAndKeepsReceipt()
    await testFailedReceiptWriteRollsBackTheInstall()
    await testReceiptWithAnUnsupportedComponentKindIsRejected()
    await testReceiptStoreValidationRejectsMalformedAndUnsafeState()
    await testUpdateAvailabilitySettlesThroughRegistryUpdate()
    await testClaudePluginRequiresTrustGrant()
    await testClaudePluginInstallsSkillsIntoClaudeHarnessAndUninstalls()
    await testClaudePluginDefaultFanOutUsesResolvedHarnesses()
    await testClaudePluginAutoResolveUpdateNeverDeletesOnProbeHiccup()
    await testClaudePluginExplicitHarnessNarrowingStillRemoves()
    await testClaudePluginResolverFailureFallsBackToClaude()
    await testClaudePluginRefusesForeignSkillDirCollision()
    await testClaudePluginHarnessChangeRemovesOrphanedCopies()
    console.log('marketplace plugin lifecycle tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
