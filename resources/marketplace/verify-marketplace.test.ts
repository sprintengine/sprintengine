import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

import { skillContentDigest } from '../../src/main/marketplace/skill-content'
import { test } from 'vitest'

test("verify-marketplace", async () => {
const workDir = mkdtempSync(join(tmpdir(), 'sprintengine-marketplace-publish-'))
const verifierBundle = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'marketplace-registry-verify-for-test.cjs')
const seedRoot = join(process.cwd(), 'resources', 'marketplace')
const registryWorkflowPath = join(seedRoot, '.github', 'workflows', 'marketplace-registry.yml')

mkdirSync(join(process.cwd(), 'node_modules', '.cache', 'sprintengine'), { recursive: true })
buildSync({
  entryPoints: [join(process.cwd(), 'resources', 'marketplace', 'verify-marketplace.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: verifierBundle,
})

type VerifyRun = {
  status: number | null
  stdout: string
  stderr: string
}

function copySeedRegistry(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  return root
}

function runVerifier(root: string): VerifyRun {
  const result = spawnSync(process.execPath, [verifierBundle, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function testSampleRegistryPasses(): void {
  const root = copySeedRegistry('valid-registry')
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as { plugins: unknown[] }
  assert.ok(seed.plugins.length >= 4, 'seed registry must carry the agent CLIs')
  assert.match(result.stdout, new RegExp(`marketplace registry verified \\(${seed.plugins.length} plugins\\)`))
}

/**
 * The registry keeps only what a Claude marketplace cannot carry.
 *
 * Until the frozen-snapshots retirement (2026-09-06) this index also held 256
 * `claude-plugin` entries — a months-old copy of
 * `anthropics/claude-plugins-official`, which the app now reads live at the
 * commits that marketplace pins. What is left is the agent CLIs the app ships:
 * the signed bundles went first, and skills and MCP servers are an
 * extension's contributions now.
 *
 * Pinned as an exact multiset rather than a floor, because the failure this
 * guards against is the index GROWING a population that belongs in a
 * marketplace — a snapshot creeping back in one publish at a time, each one
 * individually defensible.
 */
function testRegistryHoldsOnlyWhatAMarketplaceCannotCarry(): void {
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as {
    plugins: Array<{ id: string; provides?: unknown }>
  }
  const kinds = new Map<string, number>()
  for (const plugin of seed.plugins) {
    const provided = Array.isArray(plugin.provides) ? plugin.provides : []
    const names = provided
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : entry))
      .map((type) => String(type))
      .sort()
      .join('+')
    assert.ok(
      names === 'cli',
      `${plugin.id} provides "${names}"; the registry carries agent CLIs — anything a Claude marketplace can list belongs in one`
    )
    kinds.set(names, (kinds.get(names) ?? 0) + 1)
  }
  assert.deepEqual(
    [...kinds.entries()].sort(),
    [['cli', 18]],
    'the registry is 18 agent CLI integrations'
  )
}

const CLAUDE_PROBE_ID = 'claude-probe'

/** A Claude Code plugin row, as the generated catalogue writes one, pushed into `root`'s index. */
function addClaudePluginRow(root: string, overrides: Record<string, unknown> = {}): void {
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
  marketplace.plugins.push({
    id: CLAUDE_PROBE_ID,
    name: 'Claude probe',
    publisher: { name: 'Probe', verified: false },
    summary: 'A Claude Code plugin row that exists only to exercise the verifier.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    provides: ['skills'],
    tags: ['claude-plugin'],
    source: 'https://github.com/acme/probe',
    skills: [{ name: 'probe', description: 'Probe skill.' }],
    ...overrides,
  })
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
}

function testClaudePluginRowWithoutPayloadVerifies(): void {
  // A row whose skills are display metadata only carries no payload, and needs none.
  const root = copySeedRegistry('claude-row-registry')
  addClaudePluginRow(root)
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
}

function testOnlyAnInlineCliRowMayClaimAVerifiedPublisher(): void {
  const root = copySeedRegistry('claude-verified-registry')
  addClaudePluginRow(root, { publisher: { name: 'SprintEngine Labs', verified: true } })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified/)
  assert.match(result.stderr, /only an inline-CLI entry may claim a verified publisher/)
}

function testRetiredRowsAreLeftOffTheShelf(): void {
  // A published index that still lists a plugin bundle or an inline MCP row
  // keeps the rest of its rows: those two are skipped, not failed.
  const root = copySeedRegistry('retired-rows-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
  const listed = marketplace.plugins.length
  const row = {
    publisher: { name: 'Probe', verified: false },
    summary: 'A retired row.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
  }
  marketplace.plugins.push(
    { ...row, id: 'old-bundle', name: 'Old bundle', provides: ['skills'], source: 'https://github.com/acme/old' },
    { ...row, id: 'old-mcp', name: 'Old MCP', provides: ['mcp'], mcp: { servers: [{ id: 'x', command: 'x' }] } },
  )
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`marketplace registry verified \\(${listed} plugins\\)`))
}

function testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames(): void {
  // Inline-CLI entries may claim a verified publisher without a signature (the
  // referenced plugin ships inside the signed app bundle), but only under a
  // name listed as verified in trusted-publishers.json — an arbitrary name
  // must not wear the badge.
  const root = copySeedRegistry('inline-cli-publisher-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const inlineCli = marketplace.plugins.find((plugin) => plugin.cli !== undefined)
  assert.ok(inlineCli, 'generated seed must carry inline-CLI entries')
  ;(inlineCli.publisher as Record<string, unknown>).name = 'Unknown Author'
  writeFileSync(path, JSON.stringify(marketplace, null, 2))
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified.*trusted-publishers\.json/)
}

function testInlineCliMustReferenceABundledPluginInTheAppRepoLayout(): void {
  // With a bundled plugin tree beside the registry root (the app repo layout),
  // every inline-CLI entry must reference an existing plugin manifest; a
  // dangling pluginId fails the publish. The plain copySeedRegistry roots have
  // no sibling plugins tree (the standalone registry repo case), where the
  // check deliberately does not apply.
  const appRepo = join(workDir, 'inline-cli-app-repo')
  const root = join(appRepo, 'marketplace')
  mkdirSync(appRepo, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  cpSync(join(process.cwd(), 'resources', 'plugins'), join(appRepo, 'plugins'), { recursive: true })
  assert.equal(runVerifier(root).status, 0, 'seed with the full bundled plugin tree must verify')
  rmSync(join(appRepo, 'plugins', 'claude-code'), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /resources\/plugins\/claude-code\/plugin\.json/)
}

function testInlineIconMustMatchTheCommittedMark(): void {
  // The shipped mark is a base64 blob nobody can review; the committed SVG is
  // what a reviewer reads. They have to be the same bytes.
  const root = copySeedRegistry('icon-drift-registry')
  const markPath = join(root, 'icons', 'claude-code.svg')
  writeFileSync(markPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"/>\n', 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not match the committed mark/)
}

function testSchemaInvalidRegistryFailsClearly(): void {
  const root = copySeedRegistry('invalid-schema-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  marketplace.schemaVersion = 99
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /marketplace\.json\.schemaVersion/)
  assert.match(result.stderr, /schemaVersion must be 1/)
}

function testEntrySourceOnNonAllowlistedHostFails(): void {
  const root = copySeedRegistry('evil-source-registry')
  addClaudePluginRow(root, { source: `https://evil.example.com/plugins/${CLAUDE_PROBE_ID}` })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins\\.${CLAUDE_PROBE_ID}\\.source`))
  assert.match(result.stderr, /allowlist/)
}

function testEntrySourceOnAllowlistedNonCanonicalOwnerPasses(): void {
  const root = copySeedRegistry('non-canonical-owner-registry')
  addClaudePluginRow(root, { source: 'https://github.com/another-org/registry' })
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /marketplace registry verified/)
}

function testBundledSkillPayloadDigestsGateThePublish(): void {
  const root = copySeedRegistry('skill-payload-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
  const body = '---\nname: probe\n---\n'
  const files = [
    {
      path: 'SKILL.md',
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      size: Buffer.byteLength(body, 'utf8'),
    },
  ]
  marketplace.plugins.push({
    id: 'digest-probe',
    name: 'probe',
    publisher: { name: 'Probe', verified: false },
    summary: 'Digest gate probe.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    provides: ['skills'],
    tags: ['claude-plugin'],
    source: 'https://github.com/acme/probe',
    skills: [{ name: 'probe', description: 'Probe skill.', path: 'skills/probe', files, contentDigest: skillContentDigest(files) }],
  })
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  const payloadDir = join(root, 'skills', 'digest-probe', 'probe')
  mkdirSync(payloadDir, { recursive: true })
  writeFileSync(join(payloadDir, 'SKILL.md'), body, 'utf8')

  // Digest-bearing entry + matching payload verifies.
  const ok = runVerifier(root)
  assert.equal(ok.status, 0, ok.stderr)

  // Tampered payload bytes fail the publish.
  writeFileSync(join(payloadDir, 'SKILL.md'), '---\nname: evil\n---\n', 'utf8')
  const tampered = runVerifier(root)
  assert.equal(tampered.status, 1)
  assert.match(tampered.stderr, /skills\/digest-probe\/probe/)
  assert.match(tampered.stderr, /digest verification/)

  // A digest-bearing entry with no payload dir at all also fails.
  rmSync(join(root, 'skills', 'digest-probe'), { recursive: true, force: true })
  const missing = runVerifier(root)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /skills\/digest-probe/)
  assert.match(missing.stderr, /payload dir is missing/)
}

function testPublishScriptsTargetRegistryRoot(): void {
  const appPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const verifyScript = appPackage.scripts?.['verify:marketplace-registry'] ?? ''
  assert.match(verifyScript, /verify-marketplace\.ts/)
  assert.doesNotMatch(verifyScript, /--root resources\/marketplace/)

  const workflow = readFileSync(registryWorkflowPath, 'utf8')
  assert.match(workflow, /marketplace\.json/)
  assert.match(workflow, /skills\/\*\*/)
  assert.match(workflow, /trusted-publishers\.json/)
  assert.match(workflow, /--root "\$GITHUB_WORKSPACE\/registry"/)
  assert.doesNotMatch(workflow, /resources\/marketplace/)
}

try {
  testSampleRegistryPasses()
  testRegistryHoldsOnlyWhatAMarketplaceCannotCarry()
  testClaudePluginRowWithoutPayloadVerifies()
  testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames()
  testInlineCliMustReferenceABundledPluginInTheAppRepoLayout()
  testOnlyAnInlineCliRowMayClaimAVerifiedPublisher()
  testRetiredRowsAreLeftOffTheShelf()
  testInlineIconMustMatchTheCommittedMark()
  testSchemaInvalidRegistryFailsClearly()
  testEntrySourceOnNonAllowlistedHostFails()
  testEntrySourceOnAllowlistedNonCanonicalOwnerPasses()
  testBundledSkillPayloadDigestsGateThePublish()
  testPublishScriptsTargetRegistryRoot()
  console.log('marketplace publish validation tests passed')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
})
