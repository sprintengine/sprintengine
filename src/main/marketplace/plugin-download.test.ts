import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { downloadClaudeCodePluginSource } from './plugin-download'
import { skillContentDigest } from './skill-content'
import { test } from 'vitest'

test('plugin-download', async () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-marketplace-download-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // --- Claude Code plugin sources: bundled snapshot content ---------

  type BundledSkillFixture = {
    entry: MarketplacePluginEntry
    resolver: (relativePath: string) => string | null
    resourceDir: string
  }

  // Lays a bundled payload dir on disk (the shape the catalogue generator emits
  // under resources/marketplace/skills/<entryId>/) and builds the matching
  // entry with per-file digests, so download tests exercise the REAL integrity
  // path end to end.
  function createBundledSkillFixture(
    root: string,
    skillFolders: Record<string, Record<string, string>> = {
      alpha: { 'SKILL.md': '---\nname: alpha\n---\n', 'scripts/run.py': 'print("hi")\n' },
      beta: { 'SKILL.md': '---\nname: beta\n---\n' },
    },
  ): BundledSkillFixture {
    const resourceDir = join(root, 'packaged', 'skills', 'acme-skills')
    const skills = Object.entries(skillFolders).map(([folder, files]) => {
      const digests = Object.entries(files).map(([rel, body]) => {
        const abs = join(resourceDir, folder, rel)
        mkdirSync(join(abs, '..'), { recursive: true })
        writeFileSync(abs, body, 'utf8')
        return {
          path: rel,
          sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
          size: Buffer.byteLength(body, 'utf8'),
        }
      })
      return {
        name: folder,
        description: `The ${folder} skill.`,
        path: `skills/${folder}`,
        files: digests,
        contentDigest: skillContentDigest(digests),
      }
    })
    const entry: MarketplacePluginEntry = {
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
      skills,
    }
    const resolver = (relativePath: string) => (relativePath === 'skills/acme-skills' ? resourceDir : null)
    return { entry, resolver, resourceDir }
  }

  async function testClaudePluginBundledContentStagesSkills(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      const events: string[] = []
      const download = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
        log: (event) => events.push(event),
      })
      assert.equal(download.ok, true, JSON.stringify(download))
      if (!download.ok) return
      try {
        assert.deepEqual(download.skillDirs, ['alpha', 'beta'])
        assert.equal(download.claudeName, 'skills')
        // Bundled content identity, not a git commit: catalogue updates change
        // it, sending the user back through the trust prompt.
        assert.match(download.resolvedRef, /^bundled:[a-f0-9]{16}$/)
        assert.equal(
          await readFile(join(download.stagedPath, 'skills', 'alpha', 'SKILL.md'), 'utf8'),
          '---\nname: alpha\n---\n',
        )
        assert.equal(
          await readFile(join(download.stagedPath, 'skills', 'alpha', 'scripts', 'run.py'), 'utf8'),
          'print("hi")\n',
        )
        assert.equal(events.includes('claude-plugin:staged'), true)
      } finally {
        await rm(download.stagedPath, { recursive: true, force: true })
      }
    })
  }

  async function testClaudePluginWithoutBundledContentRefusedHonestly(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      // Metadata-only entry (no digests): honest offline refusal, no crawl.
      const metadataOnly: MarketplacePluginEntry = {
        ...fixture.entry,
        skills: [{ name: 'alpha', description: 'No content shipped.', path: 'skills/alpha' }],
      }
      const download = await downloadClaudeCodePluginSource({
        entry: metadataOnly,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(download.ok, false)
      if (!download.ok) assert.match(download.message, /isn.t installable offline yet/)

      // Digests present but the packaged payload dir is missing: same honest state.
      const missingPayload = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: () => null,
      })
      assert.equal(missingPayload.ok, false)
      if (!missingPayload.ok) assert.match(missingPayload.message, /isn.t installable offline yet/)
      assert.equal(existsSync(stagingRoot) ? (await readdir(stagingRoot)).length : 0, 0)
    })
  }

  async function testClaudePluginMetadataOnlySkillsSurfaced(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      // The entry lists a third skill that shipped without content (capture cap).
      const entry: MarketplacePluginEntry = {
        ...fixture.entry,
        skills: [
          ...(fixture.entry.skills ?? []),
          { name: 'capped', description: 'Too big to bundle.', path: 'skills/capped' },
        ],
      }
      const download = await downloadClaudeCodePluginSource({
        entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(download.ok, true, JSON.stringify(download))
      if (!download.ok) return
      try {
        // The two bundled skills install; the metadata-only one is named, not dropped silently.
        assert.deepEqual(download.skillDirs, ['alpha', 'beta'])
        assert.deepEqual(download.metadataOnlySkills, ['capped'])
      } finally {
        await rm(download.stagedPath, { recursive: true, force: true })
      }
    })
  }

  async function testClaudePluginOversizePayloadFailsWithoutReadingWhole(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      // Grow a listed file far past its recorded size: verification must reject
      // on the stat (size mismatch), never buffer the whole thing to hash it.
      writeFileSync(join(fixture.resourceDir, 'beta', 'SKILL.md'), Buffer.alloc(4 * 1024 * 1024, 0x61))
      const download = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(download.ok, false)
      if (!download.ok) assert.match(download.message, /size .* does not match|failed integrity/)
      assert.deepEqual(await readdir(stagingRoot), [])
    })
  }

  async function testClaudePluginTamperedPayloadRefused(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      writeFileSync(join(fixture.resourceDir, 'alpha', 'SKILL.md'), '---\nname: evil\n---\n', 'utf8')
      const download = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(download.ok, false)
      if (!download.ok) assert.match(download.message, /failed integrity verification/)
      assert.deepEqual(await readdir(stagingRoot), [])
    })
  }

  async function testClaudePluginExtraPayloadFileRefused(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      // A file the digest listing does not disclose must never install.
      writeFileSync(join(fixture.resourceDir, 'beta', 'smuggled.md'), 'undisclosed instructions', 'utf8')
      const download = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(download.ok, false)
      if (!download.ok) assert.match(download.message, /failed integrity verification/)
      assert.deepEqual(await readdir(stagingRoot), [])
    })
  }

  async function testClaudePluginRefOverridePinsBundledContent(): Promise<void> {
    await withTempDir(async (temp) => {
      const fixture = createBundledSkillFixture(temp)
      const stagingRoot = join(temp, 'staging')
      const first = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(first.ok, true, JSON.stringify(first))
      if (!first.ok) return
      await rm(first.stagedPath, { recursive: true, force: true })

      // The disclosed pin re-verifies byte-identical content.
      const pinned = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        refOverride: first.resolvedRef,
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(pinned.ok, true, JSON.stringify(pinned))
      if (pinned.ok) await rm(pinned.stagedPath, { recursive: true, force: true })

      // A stale pin (content changed under the prompt) refuses the install.
      const stale = await downloadClaudeCodePluginSource({
        entry: fixture.entry,
        stagingRoot,
        refOverride: 'bundled:0000000000000000',
        packagedResourceResolver: fixture.resolver,
      })
      assert.equal(stale.ok, false)
      if (!stale.ok) assert.match(stale.message, /changed since it was verified/)
    })
  }

  async function main(): Promise<void> {
    await testClaudePluginBundledContentStagesSkills()
    await testClaudePluginWithoutBundledContentRefusedHonestly()
    await testClaudePluginMetadataOnlySkillsSurfaced()
    await testClaudePluginOversizePayloadFailsWithoutReadingWhole()
    await testClaudePluginTamperedPayloadRefused()
    await testClaudePluginExtraPayloadFileRefused()
    await testClaudePluginRefOverridePinsBundledContent()
    console.log('marketplace plugin download tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
