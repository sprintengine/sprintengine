import assert from 'node:assert/strict'

import { MARKETPLACE_PROVIDES_KINDS, parseMarketplaceIndex, validateMarketplaceIndex } from './manifest'
import { MARKETPLACE_CANONICAL_SOURCE } from './index'
import { test } from 'vitest'

test('manifest', async () => {
  const VALID_SIGNATURE = { algorithm: 'ed25519' as const, publicKey: 'YWJj', signature: 'ZGVm' }

  // A Claude Code plugin row: the generated catalogue tags it, it names its
  // source, and it provides skills.
  const VALID_MARKETPLACE = {
    schemaVersion: 1,
    plugins: [
      {
        id: 'dev-helper',
        name: 'Dev Helper',
        publisher: { name: 'Acme', verified: false },
        summary: 'Adds development helpers.',
        category: 'dev-tools',
        icon: 'icons/dev-helper.svg',
        latest: 1,
        tags: ['claude-plugin'],
        source: 'https://github.com/acme/dev-helper',
        provides: ['skills'],
      },
    ],
  }

  // Inline-CLI entry: no source, no signature — the entry surfaces an
  // app-bundled CLI plugin whose install spec the runtime installer executes;
  // `cli.pluginId` names that plugin in the plugin registry.
  const VALID_INLINE_CLI_ENTRY = {
    id: 'claude-code',
    name: 'Claude Code',
    publisher: { name: 'SprintEngine Labs', verified: true },
    summary: "Anthropic's terminal coding agent.",
    category: 'Agent CLI',
    icon: 'icons/claude-code.svg',
    latest: 1,
    provides: ['cli'],
    cli: { pluginId: 'claude-code' },
  }

  // What a published index may still list from before skills and MCP servers
  // became an extension's contributions.
  const RETIRED_BUNDLE_ROW = {
    ...VALID_MARKETPLACE.plugins[0],
    id: 'old-bundle',
    tags: [],
    signature: VALID_SIGNATURE,
  }
  const RETIRED_INLINE_MCP_ROW = {
    id: 'live-search-mcp',
    name: 'Live Search MCP',
    publisher: { name: 'Community Author', verified: false },
    summary: 'Adds a hosted web search MCP server.',
    category: 'Search',
    icon: 'icons/live-search.svg',
    latest: 1,
    provides: ['mcp'],
    mcp: {
      servers: [{ id: 'live-search', name: 'Live Search', transport: 'http', url: 'https://mcp.example.com/mcp' }],
    },
  }

  function withoutField<T extends Record<string, unknown>>(value: T, field: string): Record<string, unknown> {
    const next: Record<string, unknown> = { ...value }
    delete next[field]
    return next
  }

  function issuePaths(issues: Array<{ path: string }>): string[] {
    return issues.map((issue) => issue.path)
  }

  function assertRejectsAt(
    value: unknown,
    path: string,
    validator: (value: unknown) => { ok: true } | { ok: false; issues: Array<{ path: string }> },
  ): void {
    const result = validator(value)
    assert.equal(result.ok, false, `${path} should be rejected`)
    if (!result.ok) assert.ok(issuePaths(result.issues).includes(path), `expected issue at ${path}`)
  }

  function testValidMarketplaceIndex(): void {
    const result = validateMarketplaceIndex(VALID_MARKETPLACE)
    assert.equal(result.ok, true)
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.equal(result.marketplace.schemaVersion, 1)
      assert.equal(entry.publisher.verified, false)
      assert.deepEqual(entry.provides, ['skills'])
      // Legacy singular category parses and no widened fields are invented.
      assert.equal(entry.category, 'dev-tools')
      assert.equal(entry.categories, undefined)
      assert.deepEqual(entry.tags, ['claude-plugin'])
      assert.equal(entry.signature, undefined)
    }
  }

  function testProvidesIsSkillsOrCli(): void {
    assert.deepEqual([...MARKETPLACE_PROVIDES_KINDS], ['skills', 'cli'])
    for (const kind of ['theme', 'module']) {
      assertRejectsAt(
        { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: [kind] }] },
        'plugins[0].provides[0]',
        validateMarketplaceIndex,
      )
    }
  }

  // A plugin bundle (a source row that is not a Claude Code plugin), an inline
  // MCP row and a row providing MCP servers are each left off the shelf: the
  // index still reads, and every other row survives.
  function testRetiredRowsAreLeftOffTheShelf(): void {
    const rows = [
      RETIRED_BUNDLE_ROW,
      RETIRED_INLINE_MCP_ROW,
      { ...VALID_MARKETPLACE.plugins[0], id: 'mcp-and-skills', provides: ['mcp', 'skills'] },
      { ...VALID_MARKETPLACE.plugins[0], id: 'nightly-sweep-automation', provides: ['automation'] },
    ]
    for (const row of rows) {
      const index = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [row, VALID_MARKETPLACE.plugins[0]] })
      assert.equal(index.ok, true, `${row.id}: ${JSON.stringify(!index.ok && index.issues)}`)
      if (index.ok)
        assert.deepEqual(
          index.marketplace.plugins.map((plugin) => plugin.id),
          ['dev-helper'],
          `${row.id} is left off the shelf`,
        )
    }
  }

  function testEntryRejectsSourceAndCliTogether(): void {
    const hybrid = { ...VALID_INLINE_CLI_ENTRY, source: 'https://github.com/acme/dev-helper' }
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [hybrid] }, 'plugins[0]', validateMarketplaceIndex)
    const tagged = { ...VALID_MARKETPLACE.plugins[0], cli: { pluginId: 'claude-code' } }
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [tagged] }, 'plugins[0]', validateMarketplaceIndex)
  }

  function testEntryRejectsNeitherSourceNorCli(): void {
    const bare = withoutField(VALID_MARKETPLACE.plugins[0], 'source')
    assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [bare] }, 'plugins[0]', validateMarketplaceIndex)
  }

  function testGeneratedClaudePluginShapedEntryValidates(): void {
    // The shape the generated catalogue writes for a Claude Code plugin:
    // unsigned, source-bearing, skills-providing, data-URI icon, categories +
    // tags arrays, latest pinned to 1.
    const generated = {
      id: 'anthropic-github',
      name: 'github',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'GitHub workflows for Claude Code.',
      category: 'development',
      categories: ['development'],
      tags: ['git', 'automation', 'claude-plugin'],
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      source: 'https://github.com/anthropics/claude-plugins-official',
    }
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true)
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.equal(entry.signature, undefined)
      assert.deepEqual(entry.provides, ['skills'])
      assert.equal(entry.category, 'development')
      assert.equal(entry.icon.startsWith('data:image/svg+xml;base64,'), true)
    }
  }

  function testBundledSkillsValidateAndSurvive(): void {
    // Enumerated per-plugin skills must ride through the field-by-field
    // entry rebuild — a dropped array would silently blank every "Skills N"
    // detail. Path is optional; empty arrays are normalized away.
    const generated = {
      id: 'anthropic-huggingface-skills',
      name: 'huggingface-skills',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'Build, train, evaluate, and use open source AI models.',
      category: 'development',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      tags: ['claude-plugin'],
      source: 'https://github.com/huggingface/skills.git',
      skills: [
        { name: 'hf-cli', description: 'Hugging Face Hub CLI.', path: 'skills/hf-cli' },
        { name: 'huggingface-datasets', description: 'Dataset Viewer API workflows.' },
      ],
    }
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.marketplace.plugins[0].skills, [
        { name: 'hf-cli', description: 'Hugging Face Hub CLI.', path: 'skills/hf-cli' },
        { name: 'huggingface-datasets', description: 'Dataset Viewer API workflows.' },
      ])
    }
    // An empty skills array normalizes to an absent field.
    const empty = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [] }] })
    assert.equal(empty.ok, true)
    if (empty.ok) assert.equal(empty.marketplace.plugins[0].skills, undefined)
    // Malformed shapes are rejected at their path, never silently dropped.
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: 'not-an-array' }] },
      'plugins[0].skills',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ description: 'nameless' }] }] },
      'plugins[0].skills[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ name: 'x', description: 'y', path: '' }] }] },
      'plugins[0].skills[0].path',
      validateMarketplaceIndex,
    )
    // A traversal or backslash path would escape the payload root when the
    // install derives the folder — rejected even for metadata-only skills.
    for (const evil of ['../escape', 'skills/..\\..\\evil', '/abs/skill', 'skills/./x']) {
      assertRejectsAt(
        { ...VALID_MARKETPLACE, plugins: [{ ...generated, skills: [{ name: 'x', description: 'y', path: evil }] }] },
        'plugins[0].skills[0].path',
        validateMarketplaceIndex,
      )
    }
  }

  function testBundledSkillContentDigestsValidateAndSurvive(): void {
    const digest = 'a'.repeat(64)
    const files = [
      { path: 'SKILL.md', sha256: digest, size: 42 },
      { path: 'scripts/run.py', sha256: 'b'.repeat(64), size: 7 },
    ]
    const generated = {
      id: 'anthropic-vercel',
      name: 'vercel',
      publisher: { name: 'Anthropic', verified: false },
      summary: 'Vercel skills.',
      category: 'development',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      latest: 1,
      provides: ['skills'],
      tags: ['claude-plugin'],
      source: 'https://github.com/vercel/skills.git',
      skills: [{ name: 'vercel', description: 'Deploy.', path: 'skills/vercel', files, contentDigest: digest }],
    }
    // Content digests ride through the rebuild — the offline install
    // verifies bundled bytes against exactly these.
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [generated] })
    assert.equal(result.ok, true, JSON.stringify(!result.ok && result.issues))
    if (result.ok) {
      assert.deepEqual(result.marketplace.plugins[0].skills?.[0].files, files)
      assert.equal(result.marketplace.plugins[0].skills?.[0].contentDigest, digest)
    }

    const withSkill = (skill: Record<string, unknown>) => ({
      ...VALID_MARKETPLACE,
      plugins: [{ ...generated, skills: [skill] }],
    })
    const base = { name: 'vercel', description: 'Deploy.', path: 'skills/vercel' }
    // files and contentDigest only come as a pair.
    assertRejectsAt(withSkill({ ...base, files }), 'plugins[0].skills[0]', validateMarketplaceIndex)
    assertRejectsAt(withSkill({ ...base, contentDigest: digest }), 'plugins[0].skills[0]', validateMarketplaceIndex)
    // A digest-bearing skill needs the folder path used to locate the payload.
    assertRejectsAt(
      withSkill({ name: 'vercel', description: 'Deploy.', files, contentDigest: digest }),
      'plugins[0].skills[0].path',
      validateMarketplaceIndex,
    )
    // Malformed digests, traversal paths, and duplicates all fail the index.
    assertRejectsAt(
      withSkill({ ...base, files: [{ path: 'SKILL.md', sha256: 'nope', size: 1 }], contentDigest: digest }),
      'plugins[0].skills[0].files[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [{ path: '../escape.md', sha256: digest, size: 1 }], contentDigest: digest }),
      'plugins[0].skills[0].files[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [files[0], files[0]], contentDigest: digest }),
      'plugins[0].skills[0].files[1].path',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files: [], contentDigest: digest }),
      'plugins[0].skills[0].files',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      withSkill({ ...base, files, contentDigest: 'not-hex' }),
      'plugins[0].skills[0].contentDigest',
      validateMarketplaceIndex,
    )
  }

  function testInlineCliEntryValidates(): void {
    const result = validateMarketplaceIndex({ ...VALID_MARKETPLACE, plugins: [VALID_INLINE_CLI_ENTRY] })
    assert.equal(result.ok, true, 'inline-CLI entry should validate')
    if (result.ok) {
      const entry = result.marketplace.plugins[0]
      assert.deepEqual(entry.provides, ['cli'])
      assert.equal(entry.source, undefined)
      assert.deepEqual(entry.cli, { pluginId: 'claude-code' })
    }
  }

  function testInlineCliRejectsOtherShapesAndBadPluginId(): void {
    assertRejectsAt(
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_INLINE_CLI_ENTRY, source: 'https://github.com/sprintengine/studio-releases' }],
      },
      'plugins[0]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, provides: ['cli', 'skills'] }] },
      'plugins[0].provides',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, cli: {} }] },
      'plugins[0].cli.pluginId',
      validateMarketplaceIndex,
    )
    // `cli` is the inline lane only: a Claude Code plugin that says it
    // provides an agent CLI is refused, because agent CLIs ship with the app.
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: ['skills', 'cli'] }] },
      'plugins[0].provides',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_INLINE_CLI_ENTRY, cli: { pluginId: 'Not A Plugin Id' } }] },
      'plugins[0].cli.pluginId',
      validateMarketplaceIndex,
    )
  }

  function testCategoriesAndTagsMustBeStringArrays(): void {
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], categories: 'Search' }] },
      'plugins[0].categories',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], tags: ['claude-plugin', ''] }] },
      'plugins[0].tags[1]',
      validateMarketplaceIndex,
    )
  }

  function testCanonicalSourceConstantExported(): void {
    assert.deepEqual(MARKETPLACE_CANONICAL_SOURCE, { owner: 'sprintengine', repo: 'studio-releases', ref: 'main' })
  }

  function testMarketplaceMissingTopLevelFields(): void {
    assertRejectsAt(withoutField(VALID_MARKETPLACE, 'schemaVersion'), 'schemaVersion', validateMarketplaceIndex)
    assertRejectsAt(withoutField(VALID_MARKETPLACE, 'plugins'), 'plugins', validateMarketplaceIndex)
  }

  function testMarketplaceMissingPluginFields(): void {
    // signature is optional; the source/cli XOR check owns the missing-source
    // rejection (covered by testEntryRejectsNeitherSourceNorCli).
    const required = ['id', 'name', 'publisher', 'summary', 'category', 'icon', 'latest', 'provides']
    for (const field of required) {
      const plugin = withoutField(VALID_MARKETPLACE.plugins[0], field)
      assertRejectsAt({ ...VALID_MARKETPLACE, plugins: [plugin] }, `plugins[0].${field}`, validateMarketplaceIndex)
    }
  }

  function testMarketplaceRejectsNestedInvalidFields(): void {
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { verified: true } }] },
      'plugins[0].publisher.name',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      {
        ...VALID_MARKETPLACE,
        plugins: [{ ...VALID_MARKETPLACE.plugins[0], publisher: { name: 'SprintEngine Labs' } }],
      },
      'plugins[0].publisher.verified',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], provides: ['skills', 'theme'] }] },
      'plugins[0].provides[1]',
      validateMarketplaceIndex,
    )
    assertRejectsAt(
      { ...VALID_MARKETPLACE, plugins: [{ ...VALID_MARKETPLACE.plugins[0], signature: { algorithm: 'rsa' } }] },
      'plugins[0].signature.algorithm',
      validateMarketplaceIndex,
    )
  }

  function testParseMarketplaceInvalidJson(): void {
    assert.equal(parseMarketplaceIndex('{not json').ok, false)
  }

  testValidMarketplaceIndex()
  testProvidesIsSkillsOrCli()
  testRetiredRowsAreLeftOffTheShelf()
  testGeneratedClaudePluginShapedEntryValidates()
  testBundledSkillsValidateAndSurvive()
  testBundledSkillContentDigestsValidateAndSurvive()
  testEntryRejectsSourceAndCliTogether()
  testEntryRejectsNeitherSourceNorCli()
  testInlineCliEntryValidates()
  testInlineCliRejectsOtherShapesAndBadPluginId()
  testCategoriesAndTagsMustBeStringArrays()
  testCanonicalSourceConstantExported()
  testMarketplaceMissingTopLevelFields()
  testMarketplaceMissingPluginFields()
  testMarketplaceRejectsNestedInvalidFields()
  testParseMarketplaceInvalidJson()
  console.log('marketplace manifest tests passed')
})
