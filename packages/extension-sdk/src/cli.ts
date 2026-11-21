#!/usr/bin/env node
// sprintengine-extension — packaging and signing CLI for SprintEngine Studio
// extension authors. Runs without repo access: everything it needs
// ships in the @sprintengine/extension-sdk tarball.
//
//   init             create an extension project from one of the templates
//   add              add a part (main, mcp, settings, door) to an extension project
//   keygen           generate an ed25519 signing keypair (private key PEM)
//   pack             validate an extension folder and assemble an installable copy
//   sign             write extension.sig, a detached ed25519 signature, beside extension.json
//   verify           check an extension folder the way the studio will
//   plugin scaffold  create a plugin bundle skeleton
//   plugin pack      validate and assemble an installable plugin bundle
//   plugin sign      write a detached ed25519 signature into plugin.json
//   plugin verify    check a plugin bundle the way the studio will
//
// sign records the sha256 of every file the extension ships, extension.json
// included, in extension.sig and signs those digests, so the signature covers
// the declaration and the code together; the app trusts an extension by its
// publisher key only when the folder matches them exactly.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_SIGNATURE_FILENAME,
  EXTENSION_SURFACE_POINTS,
  parseExtensionManifest,
  type ExtensionManifest,
} from './extension-manifest.js'
import type { ThirdPartyManifestIssue } from './manifest-validate.js'
import { computeModuleFileDigestsSync, moduleFileDigestIssuesSync } from './module-files.js'
import {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
} from './plugin-manifest.js'
import {
  computeMarketplacePluginComponentsWithDigestsSync,
  marketplaceComponentDigestMismatchIssuesSync,
} from './plugin-component-digests.js'
import {
  generateModuleSigningKeyPair,
  parseExtensionSignature,
  signExtensionFiles,
  signManifest,
  verifyExtensionSignature,
  verifyModuleSignature,
  type ExtensionSignature,
} from './signing.js'

const USAGE = `sprintengine-extension — pack, sign, and verify SprintEngine Studio extensions

Usage:
  sprintengine-extension init <dir> --template <id> [--with <part,...>] [--id <module-id>] [--name <name>] [--sdk-tarball <file>] [--force]
  sprintengine-extension add <part>... [--project <dir>] [--force]
  sprintengine-extension keygen [--out <file>] [--force]
  sprintengine-extension pack <extension-dir> [--out <dir>] [--force]
  sprintengine-extension sign <extension-dir> --key <private-key.pem>
  sprintengine-extension verify <extension-dir>
  sprintengine-extension plugin scaffold <plugin-id> [--out <dir>] [--component <kind>]... [--force]
  sprintengine-extension plugin pack <plugin-dir> [--out <dir>] [--force]
  sprintengine-extension plugin sign <plugin-dir> --key <private-key.pem>
  sprintengine-extension plugin verify <plugin-dir>

init creates an extension project in <dir> from a template: the extension, its
build and dev-loop scripts, and the agent instructions that send whichever agent
works on it to the extension guide. --id defaults to the folder name, --name to the id title-cased;
--sdk-tarball depends on a local SDK tarball instead of the npm release. Run it
with an unknown --template to list the templates. --with adds parts on top of
the template, as add does.

add puts a part into an existing project (--project, default the current
folder): main (src/main.ts, the worker, and its build), mcp (MCP tools served
by the worker), settings (a Settings section), door (a full-page surface). It
copies the part's files and test, merges what it contributes, its permissions
and the tier it needs into extension/extension.json, adds its build script,
and wires a worker part into src/main.ts. A part that needs the worker brings
it too. Run it with no part to list them.

keygen writes an ed25519 private key (PKCS#8 PEM) to --out
(default module-signing.key); a leading ~ is your home folder, on Windows too.
Keep it out of the extension's folder and out of version control; sign derives
the public key from it.

pack validates <extension-dir>/extension.json, checks that every file it names
is there, and copies the extension into --out (default packed/<id>) as an
installable folder. node_modules, .git, key files (*.key, *.pem) and symbolic
links are never copied.

sign validates extension.json, records the sha256 of every file the extension
ships (everything pack copies, extension.json included) in extension.sig, and
signs those digests with --key. Sign again after any change to its files.

verify validates extension.json, checks extension.sig's signature, and checks
that the files pack would copy are exactly the ones it lists, byte for byte:
exit 0 with the signer fingerprint when all of that holds, exit 1 when the
extension is unsigned or was changed after signing.

plugin scaffold creates plugin.json plus component placeholders for mcp and
skills by default. Pass --component repeatedly to scaffold
only the kinds you want.

plugin sign writes component file digests into the normalized plugin.json bundle
manifest before signing it. plugin pack validates plugin.json through the
marketplace plugin validator, verifies the signature and component digests, and
copies the bundle while excluding key material.`

type CliIssue = ThirdPartyManifestIssue | MarketplaceManifestIssue

function fail(message: string, issues?: CliIssue[]): never {
  console.error(message)
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
  process.exit(1)
}

function readManifest(extensionDir: string): { manifestPath: string; manifest: ExtensionManifest } {
  const manifestPath = join(extensionDir, EXTENSION_MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) {
    fail(`No ${EXTENSION_MANIFEST_FILENAME} in ${extensionDir}.`)
  }
  // The author's check: engines.studio must cover every field the manifest uses.
  const result = parseExtensionManifest(readFileSync(manifestPath, 'utf8'), { authoring: true })
  if (!result.ok) {
    fail(`Invalid extension manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

/** Every file extension.json names: the worker, each surface's entry, the images. */
function declaredFiles(manifest: ExtensionManifest): Array<{ path: string; file: string }> {
  const files: Array<{ path: string; file: string }> = []
  if (manifest.main) files.push({ path: 'main', file: manifest.main })
  for (const point of EXTENSION_SURFACE_POINTS) {
    manifest.contributes[point].forEach((surface, index) =>
      files.push({ path: `contributes.${point}[${index}].entry`, file: surface.entry }),
    )
  }
  if (manifest.icon) files.push({ path: 'icon', file: manifest.icon })
  if (manifest.cover) files.push({ path: 'cover', file: manifest.cover })
  manifest.screenshots?.forEach((file, index) => files.push({ path: `screenshots[${index}]`, file }))
  return files
}

function readSignature(extensionDir: string): ExtensionSignature | null {
  const path = join(extensionDir, EXTENSION_SIGNATURE_FILENAME)
  if (!existsSync(path)) return null
  const parsed = parseExtensionSignature(readFileSync(path, 'utf8'))
  if (!parsed.ok) fail(`${path}: ${parsed.message}`)
  return parsed.signature
}

function readPluginAuthoringManifest(pluginDir: string): {
  manifestPath: string
  manifest: MarketplacePluginAuthoringManifest
} {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginAuthoringManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function readPluginManifest(pluginDir: string): { manifestPath: string; manifest: MarketplacePluginManifest } {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function componentId(pluginId: string, suffix: string): string {
  const maxBaseLength = 63 - suffix.length - 1
  const base = pluginId.slice(0, maxBaseLength).replace(/-+$/g, '') || 'plugin'
  return `${base}-${suffix}`
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pluginComponentsFromKinds(kinds: MarketplaceComponentKind[], id: string): MarketplacePluginComponents {
  const components: MarketplacePluginComponents = {}
  for (const kind of kinds) {
    switch (kind) {
      case 'mcp':
        components.mcp = { path: 'mcp/server.json' }
        break
      case 'skills':
        components.skills = { path: `skills/${id}` }
        break
    }
  }
  return components
}

function parseComponentKinds(raw: unknown): MarketplaceComponentKind[] {
  const requested = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [...MARKETPLACE_COMPONENT_KINDS]
  const kinds: MarketplaceComponentKind[] = []
  const issues: MarketplaceManifestIssue[] = []
  for (const [index, value] of requested.entries()) {
    if (typeof value !== 'string' || !MARKETPLACE_COMPONENT_KINDS.includes(value as MarketplaceComponentKind)) {
      issues.push({
        path: `component[${index}]`,
        message: `must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.`,
      })
      continue
    }
    if (!kinds.includes(value as MarketplaceComponentKind)) kinds.push(value as MarketplaceComponentKind)
  }
  if (issues.length > 0) fail('Invalid --component value:', issues)
  // Canonical order, whatever order the flags were typed in (G13). See
  // `canonicalComponentOrder` for why this is not cosmetic.
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => kinds.includes(kind))
}

/**
 * The plugin's components, keyed in `MARKETPLACE_COMPONENT_KINDS` order (G13).
 *
 * This looks cosmetic and is not. A registry entry's `provides` array must
 * equal the kinds of the bundle it points at, and the app derives that list by
 * filtering `MARKETPLACE_COMPONENT_KINDS` — so `provides` is ALWAYS in canonical
 * order on the app's side, while an author reading their own plugin.json copies
 * whatever order they happen to see there. `["skills","mcp"]` against a bundle
 * the downloader reads as `mcp, skills` is a registry mismatch that fails at
 * install, on the user's machine, with a message about a list that looks
 * identical to the one they wrote. Writing plugin.json in the canonical order is
 * how the two are kept from disagreeing at the only point an author looks.
 */
function canonicalComponentOrder(components: MarketplacePluginComponents): MarketplacePluginComponents {
  const ordered: MarketplacePluginComponents = {}
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const component = components[kind]
    if (component !== undefined) ordered[kind] = component
  }
  return ordered
}

/** The `provides` list a registry entry for this bundle must carry, verbatim. */
function providesForComponents(components: MarketplacePluginComponents): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => components[kind] !== undefined)
}

function assertPluginComponentDigestsMatch(pluginDir: string, manifest: MarketplacePluginManifest): void {
  const issues = marketplaceComponentDigestMismatchIssuesSync(pluginDir, manifest, {
    bytesLabel: 'current bytes',
    blockedFileMessage: (path) => `component file "${path}" cannot be signed or packed.`,
  })
  if (issues.length > 0) fail(`Plugin component digests do not match ${pluginDir}:`, issues)
}

function uniqueSiblingPath(parent: string, name: string): string {
  let attempt = 0
  while (true) {
    const candidate = join(parent, `.${name}.${process.pid}.${Date.now()}.${attempt}`)
    if (!existsSync(candidate)) return candidate
    attempt += 1
  }
}

function publishPackedDirectory(tempDir: string, outDir: string): void {
  const outParent = dirname(outDir)
  const previousDir = existsSync(outDir) ? uniqueSiblingPath(outParent, `${basename(outDir)}.previous`) : null
  if (previousDir) renameSync(outDir, previousDir)
  try {
    renameSync(tempDir, outDir)
  } catch (error) {
    if (previousDir) {
      try {
        renameSync(previousDir, outDir)
      } catch {
        // Best effort rollback; the original error is more useful to callers.
      }
    }
    throw error
  }
  if (previousDir) rmSync(previousDir, { recursive: true, force: true })
}

// A leading `~` is the home folder. The templates' `keygen` script quotes it,
// so no shell expands it: npm runs scripts in cmd.exe on Windows, which
// expands neither `~` nor `$HOME`.
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path
}

function keygen(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
  })
  const outPath = resolve(expandHome(values.out ?? 'module-signing.key'))
  if (existsSync(outPath) && !values.force) {
    fail(`${outPath} already exists. Pass --force to overwrite it.`)
  }
  const keyPair = generateModuleSigningKeyPair()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, keyPair.privateKeyPem, { mode: 0o600 })
  console.log(`Wrote ed25519 private key to ${outPath}`)
  console.log(`Public key fingerprint: ${keyPair.fingerprint}`)
  console.log("Keep this key out of the extension's folder and out of version control.")
}

function pack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`pack requires an extension folder.\n\n${USAGE}`)
  const sourceDir = resolve(extensionDir)
  const { manifest } = readManifest(sourceDir)

  const missing: ThirdPartyManifestIssue[] = declaredFiles(manifest)
    .filter(({ file }) => !existsSync(join(sourceDir, file)))
    .map(({ path, file }) => ({ path, message: `names "${file}", which does not exist.` }))
  if (missing.length > 0) fail(`Files extension.json names are missing in ${sourceDir}:`, missing)

  // A pack whose files no longer match the signed digests would install as
  // tampered; say so here, where signing again is one command away.
  const signature = readSignature(sourceDir)
  if (signature) {
    const drift = moduleFileDigestIssuesSync(sourceDir, signature.files, { walk: 'pack' })
    if (drift.length > 0) {
      fail(`Files changed after signing in ${sourceDir}; run \`sprintengine-extension sign\` again:`, drift)
    }
  }

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (isInsideOrEqual(sourceDir, outDir)) {
    fail('The pack output directory must be outside the extension folder.')
  }

  const skipped: string[] = []
  cpSync(sourceDir, outDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = basename(src)
      if (name === 'node_modules' || name === '.git') return false
      if (lstatSync(src).isSymbolicLink()) {
        skipped.push(`${relative(sourceDir, src)} (a symbolic link)`)
        return false
      }
      if (name.endsWith('.key') || name.endsWith('.pem')) {
        skipped.push(`${name} (key material)`)
        return false
      }
      return true
    },
  })
  for (const name of skipped) console.warn(`Skipped ${name}: never packed into an extension.`)
  const signedNote = signature ? 'signed' : 'UNSIGNED — run `sprintengine-extension sign` before distributing'
  console.log(`Packed ${manifest.id} ${manifest.version} (${signedNote}) to ${outDir}`)
}

function signCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`sign requires an extension folder.\n\n${USAGE}`)
  if (!values.key) fail('sign requires --key <private-key.pem> (create one with `sprintengine-extension keygen`).')
  const keyPath = resolve(expandHome(values.key))
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const root = resolve(extensionDir)
  const { manifest } = readManifest(root)
  // The pack view: node_modules, .git and key files are left out here exactly
  // as pack leaves them out, so the packed copy matches what was signed.
  const digests = computeModuleFileDigestsSync(root, { walk: 'pack' })
  if (!digests.ok) fail(`Files in ${root} cannot be signed:`, digests.issues)
  const missing: ThirdPartyManifestIssue[] = declaredFiles(manifest)
    .filter(({ file }) => digests.files[file] === undefined)
    .map(({ path, file }) => ({ path, message: `names "${file}", which is not in the extension.` }))
  if (missing.length > 0) fail(`Files extension.json names are missing in ${root}:`, missing)
  let signature: ExtensionSignature
  try {
    signature = signExtensionFiles(digests.files, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signaturePath = join(root, EXTENSION_SIGNATURE_FILENAME)
  writeFileSync(signaturePath, JSON.stringify(signature, null, 2) + '\n')
  const { fingerprint } = verifyExtensionSignature(signature)
  console.log(`Signed ${manifest.id} and ${Object.keys(digests.files).length} file(s); wrote ${signaturePath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function verifyCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`verify requires an extension folder.\n\n${USAGE}`)
  const root = resolve(extensionDir)
  const { manifest } = readManifest(root)
  const signature = readSignature(root)
  if (!signature) {
    fail(
      `${manifest.id} is unsigned. The app will show it as 'unsigned'; sign it with \`sprintengine-extension sign\`.`,
    )
  }
  const { valid, fingerprint } = verifyExtensionSignature(signature)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (extension.sig changed after signing, or wrong key). ` +
        'The app will refuse to trust it. Sign it again.',
    )
  }
  const drift = moduleFileDigestIssuesSync(root, signature.files, { walk: 'pack', label: 'signed digests' })
  if (drift.length > 0) {
    fail(
      `${manifest.id} does not match the file digests extension.sig signs (changed after signing?). ` +
        'The app will refuse it as tampered. Sign it again with `sprintengine-extension sign`.',
      drift,
    )
  }
  console.log(`${manifest.id}: signature valid; ${Object.keys(signature.files).length} file(s) match`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function pluginScaffold(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      component: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id) fail(`plugin scaffold requires a plugin id.\n\n${USAGE}`)
  const displayName = displayNameFromId(id)
  const components = pluginComponentsFromKinds(parseComponentKinds(values.component), id)
  const outDir = resolve(values.out ?? id)
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to scaffold into it.`)
  }
  const draft = {
    id,
    displayName,
    version: 1,
    publisher: 'Your Name',
    category: 'dev-tools',
    summary: `${displayName} marketplace plugin.`,
    defaultEnabled: false,
    permissions: ['network'],
    components,
  }
  const draftValidation = validateMarketplacePluginAuthoringManifest(draft)
  if (!draftValidation.ok) {
    fail('plugin scaffold cannot create a valid plugin.json from those inputs:', draftValidation.issues)
  }
  mkdirSync(outDir, { recursive: true })

  writeJson(join(outDir, 'plugin.json'), {
    ...draftValidation.manifest,
    components: canonicalComponentOrder(draftValidation.manifest.components),
  })

  if (components.mcp) {
    writeJson(join(outDir, components.mcp.path), {
      servers: [
        {
          id: componentId(id, 'mcp'),
          name: `${displayName} MCP`,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      ],
    })
  }
  if (components.skills) {
    const skillDir = join(outDir, components.skills.path)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${displayName} skill placeholder.\n---\n\nDescribe when and how this skill should be used.\n`,
    )
  }
  console.log(`Scaffolded marketplace plugin ${id} at ${outDir}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(components))}`)
  console.log(
    'Run `sprintengine-extension keygen`, then `sprintengine-extension plugin sign`, then `sprintengine-extension plugin verify`.',
  )
}

function pluginPack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin pack requires a plugin directory.\n\n${USAGE}`)
  const sourceDir = resolve(pluginDir)
  const { manifest } = readPluginManifest(sourceDir)
  const { valid } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(`${manifest.id} has an INVALID signature. Re-sign the plugin before packing it.`)
  }
  assertPluginComponentDigestsMatch(sourceDir, manifest)

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (isInsideOrEqual(sourceDir, outDir)) {
    fail('The plugin pack output directory must be outside the plugin directory.')
  }

  const skipped: string[] = []
  const outParent = dirname(outDir)
  mkdirSync(outParent, { recursive: true })
  const tempDir = uniqueSiblingPath(outParent, `${basename(outDir)}.tmp`)
  try {
    cpSync(sourceDir, tempDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = basename(src)
        if (name === 'node_modules' || name === '.git') return false
        if (name.endsWith('.key') || name.endsWith('.pem')) {
          skipped.push(name)
          return false
        }
        return true
      },
    })
    publishPackedDirectory(tempDir, outDir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    fail(`Could not pack plugin to ${outDir}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  for (const name of skipped) {
    console.warn(`Skipped ${name}: key material is never packed into a plugin.`)
  }
  console.log(`Packed ${manifest.id} (signature valid) to ${outDir}`)
}

function pluginSign(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin sign requires a plugin directory.\n\n${USAGE}`)
  if (!values.key)
    fail('plugin sign requires --key <private-key.pem> (create one with `sprintengine-extension keygen`).')
  const keyPath = resolve(values.key)
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const pluginRoot = resolve(pluginDir)
  const { manifestPath, manifest } = readPluginAuthoringManifest(pluginRoot)
  const { signature: _prior, ...unsigned } = manifest
  const componentsWithDigests = computeMarketplacePluginComponentsWithDigestsSync(pluginRoot, unsigned.components, {
    blockedFileMessage: (path) => `component file "${path}" cannot be signed or packed.`,
  })
  if (!componentsWithDigests.ok) {
    fail(`Plugin component files are not packable in ${pluginRoot}:`, componentsWithDigests.issues)
  }
  const unsignedWithDigests: MarketplacePluginAuthoringManifest = {
    ...unsigned,
    // G13: the signed manifest is written back in canonical component order, so
    // the `provides` an author copies out of it is the one the registry
    // mismatch gate computes.
    components: canonicalComponentOrder(componentsWithDigests.components),
  }
  let signature
  try {
    signature = signManifest(unsignedWithDigests, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signed: MarketplacePluginManifest = { ...unsignedWithDigests, signature }
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n')
  const { fingerprint } = verifyModuleSignature(signed)
  console.log(`Signed plugin ${manifest.id}; wrote normalized manifest to ${manifestPath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(unsignedWithDigests.components))}`)
}

function pluginVerify(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin verify requires a plugin directory.\n\n${USAGE}`)

  const sourceDir = resolve(pluginDir)
  const authoring = readPluginAuthoringManifest(sourceDir)
  if (!authoring.manifest.signature) {
    fail(
      `${authoring.manifest.id} is unsigned. The app will refuse to install it; sign it with \`sprintengine-extension plugin sign\`.`,
    )
  }
  const { manifest } = readPluginManifest(sourceDir)
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (plugin.json changed after signing, or wrong key). ` +
        'The app will refuse to install it. Re-sign the plugin.',
    )
  }
  assertPluginComponentDigestsMatch(sourceDir, manifest)
  console.log(`${manifest.id}: plugin signature valid`)
  console.log(`Signer fingerprint: ${fingerprint}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(manifest.components))}`)
}

function pluginCommand(args: string[]): void {
  const [command, ...rest] = args
  switch (command) {
    case 'scaffold':
      pluginScaffold(rest)
      break
    case 'pack':
      pluginPack(rest)
      break
    case 'sign':
      pluginSign(rest)
      break
    case 'verify':
      pluginVerify(rest)
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE)
      break
    default:
      fail(`Unknown plugin command "${command}".\n\n${USAGE}`)
  }
}

// The scaffolder is loaded only for `init`: it finds its templates relative to
// its own file, which a bundle of this CLI need not preserve for the other
// commands.
async function init(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      template: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      'sdk-tarball': { type: 'string' },
      with: { type: 'string', multiple: true },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const { listModuleTemplates, scaffoldModuleProject, sdkPackageVersion } = await import('./scaffold.js')
  const parts = (values.with ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  const templates = (): string =>
    listModuleTemplates()
      .map((template) => `  ${template.id.padEnd(20)} ${template.summary}`)
      .join('\n')
  const dir = positionals[0]
  if (!dir) fail(`init requires a project directory.\n\n${USAGE}`)
  if (!values.template) fail(`init requires --template <id>. The templates:\n${templates()}`)
  const target = resolve(dir)
  const id =
    values.id ??
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const tarball = values['sdk-tarball'] ? resolve(values['sdk-tarball']) : undefined
  if (tarball && !existsSync(tarball)) fail(`SDK tarball not found: ${tarball}`)
  const result = await scaffoldModuleProject({
    dir: target,
    templateId: values.template,
    id,
    displayName: values.name ?? displayNameFromId(id),
    sdkVersion: sdkPackageVersion(),
    ...(tarball ? { sdkTarballPath: tarball } : {}),
    ...(values.force ? { force: true } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  })
  if (!result.ok) {
    fail(result.code === 'unknown_template' ? `${result.message}\n\n${templates()}` : result.message)
  }
  const withParts = parts.length > 0 ? ` with ${parts.join(', ')}` : ''
  console.log(
    `Created ${id} from the ${values.template} template${withParts} in ${target} (${result.files.length} files).`,
  )
  for (const note of result.notes ?? []) console.log(`To do: ${note}`)
  console.log('Next: npm install, then npm run check; npm run dev:install side-loads it into Studio.')
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const { addModuleParts, listModuleParts } = await import('./scaffold.js')
  const parts = (): string =>
    listModuleParts()
      .map((part) => `  ${part.id.padEnd(12)} ${part.summary}`)
      .join('\n')
  const requested = positionals
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  if (requested.length === 0) fail(`add requires a part. The parts:\n${parts()}`)
  const dir = resolve(values.project ?? '.')
  const result = await addModuleParts({ dir, parts: requested, ...(values.force ? { force: true } : {}) })
  if (!result.ok) fail(result.code === 'unknown_part' ? `${result.message}\n\n${parts()}` : result.message)
  console.log(`Added ${result.added.join(', ')} to ${dir}:`)
  for (const file of result.files) console.log(`  ${file}`)
  for (const note of result.notes) console.log(`To do: ${note}`)
  console.log('Next: npm install (a part may add dependencies), then npm run check.')
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'init':
    init(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    break
  case 'add':
    add(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    break
  case 'keygen':
    keygen(rest)
    break
  case 'pack':
    pack(rest)
    break
  case 'sign':
    signCommand(rest)
    break
  case 'verify':
    verifyCommand(rest)
    break
  case 'plugin':
    pluginCommand(rest)
    break
  case 'plugin-scaffold':
    pluginScaffold(rest)
    break
  case 'plugin-pack':
    pluginPack(rest)
    break
  case 'plugin-sign':
    pluginSign(rest)
    break
  case 'plugin-verify':
    pluginVerify(rest)
    break
  case undefined:
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    fail(`Unknown command "${command}".\n\n${USAGE}`)
}
