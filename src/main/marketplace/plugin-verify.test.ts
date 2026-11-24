import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMarketplacePluginVerifier } from './plugin-verify'
import { skillContentDigest } from './skill-content'
import { test } from 'vitest'

test('plugin-verify', async () => {
  async function testClaudePluginPreviewDisclosesSkillListing(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'mc-verify-claude-'))
    try {
      const stagingRoot = join(temp, 'staging')
      // Bundled payload on disk + matching digests on the entry — verify reads
      // local bytes only.
      const doc = '---\nname: hf-cli\n---\n'
      const resourceDir = join(temp, 'packaged', 'skills', 'acme-skills')
      mkdirSync(join(resourceDir, 'hf-cli'), { recursive: true })
      writeFileSync(join(resourceDir, 'hf-cli', 'SKILL.md'), doc, 'utf8')
      const files = [
        {
          path: 'SKILL.md',
          sha256: createHash('sha256').update(doc, 'utf8').digest('hex'),
          size: Buffer.byteLength(doc, 'utf8'),
        },
      ]
      const verifier = createMarketplacePluginVerifier({
        stagingRoot,
        packagedResourceResolver: (relativePath) => (relativePath === 'skills/acme-skills' ? resourceDir : null),
      })
      const result = await verifier.verify({
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
        skills: [
          {
            name: 'hf-cli',
            description: 'Hub CLI.',
            path: 'skills/hf-cli',
            files,
            contentDigest: skillContentDigest(files),
          },
        ],
      })
      // Claude plugins verify as unsigned (they carry no studio manifest) and
      // disclose the REAL skill listing the trust grant would install.
      assert.equal(result.classification, 'unsigned')
      assert.deepEqual(result.permissions, [])
      assert.deepEqual(result.files, ['skills/hf-cli'])
      // The bundled-content identity rides the result so the install re-checks
      // exactly what this listing disclosed.
      assert.deepEqual(Object.keys(result.pin?.componentDigests ?? {}), ['skills/hf-cli'])
      assert.match(result.pin?.manifestSha256 ?? '', /^[a-f0-9]{64}$/)
      // The pre-trust preview leaves no staged bytes behind.
      assert.deepEqual(await readdir(stagingRoot), [])
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  // Claude Code plugins are the one kind of row the marketplace installs; an
  // agent CLI row ships with the app and has nothing to review.
  async function testANonClaudeEntryIsInvalid(): Promise<void> {
    const verifier = createMarketplacePluginVerifier({})
    const result = await verifier.verify({
      id: 'claude-code',
      name: 'Claude Code',
      publisher: { name: 'SprintEngine Labs', verified: true },
      summary: 'A terminal coding agent.',
      category: 'Agent CLI',
      icon: 'icons/claude-code.svg',
      latest: 1,
      provides: ['cli'],
      cli: { pluginId: 'claude-code' },
    })
    assert.equal(result.classification, 'invalid')
    assert.deepEqual(result.permissions, [])
    assert.match(result.message ?? '', /is not a Claude Code plugin/)
    assert.equal(result.pin, undefined)
  }

  await testClaudePluginPreviewDisclosesSkillListing()
  await testANonClaudeEntryIsInvalid()
})
