// Round-trip acceptance test for the `sprintengine-extension` CLI.
//
// Proves the signer and the verifier can never disagree by running BOTH paths
// over the same on-disk fixtures:
//   1. CLI sign → the SDK's own reading of extension.sig (the code Studio
//      runs) accepts the signature and names the same signer.
//   2. A tampered extension is refused by CLI `verify` AND by the SDK's
//      verification, reading the identical bytes.
//   3. `pack` fails with actionable errors on invalid manifests and never
//      copies key material.
//
// The CLI is exercised as a real subprocess (bundled from source with esbuild,
// the same toolchain `npm run build` uses) so argument parsing, exit codes,
// and the bytes written to disk are all covered.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { EXTENSION_MANIFEST_SINCE } from '../src/extension-manifest.js'
import {
  computeModuleFileDigestsSync,
  moduleFileDigestIssuesSync,
  parseExtensionSignature,
  verifyExtensionSignature,
} from '../src/signing.js'

type CliRun = { status: number | null; stdout: string; stderr: string }

let workDir = ''
let cliBundle = ''
let keyPath = ''
let fixtureCount = 0

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-roundtrip-'))
  cliBundle = join(workDir, 'sprintengine-extension.cjs')
  buildSync({
    entryPoints: [join(process.cwd(), 'packages/extension-sdk/src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: cliBundle,
    logLevel: 'silent',
  })
  keyPath = join(workDir, 'signing.key')
  const made = runCli(['keygen', '--out', keyPath])
  assert.equal(made.status, 0, made.stderr)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runCli(args: string[], cwd: string = workDir, env?: NodeJS.ProcessEnv): CliRun {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliBundle, ...args], {
    cwd,
    encoding: 'utf8',
    ...(env ? { env } : {}),
  })
  return { status, stdout, stderr }
}

function validManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'cli-roundtrip-fixture',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'worker',
    name: 'CLI Roundtrip Fixture',
    permissions: ['storage:own'],
    main: 'main.cjs',
    contributes: { panels: [{ id: 'notes', title: 'Notes', entry: 'dist/notes.js' }] },
  }
}

// Writes extension.json and every file it names, so a fixture is complete
// unless a test takes something away.
function writeExtensionFixture(manifest: Record<string, unknown>): string {
  const dir = join(workDir, `extension-${fixtureCount++}`)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'extension.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, 'main.cjs'), 'exports.activate = () => {}\n')
  writeFileSync(join(dir, 'dist', 'notes.js'), 'export function mount() {}\n')
  return dir
}

function readSignature(dir: string) {
  const parsed = parseExtensionSignature(readFileSync(join(dir, 'extension.sig'), 'utf8'))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.signature
}

test('keygen writes a PEM key, refuses to overwrite it, and expands a leading ~ itself', () => {
  assert.ok(readFileSync(keyPath, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'))
  const again = runCli(['keygen', '--out', keyPath])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /--force/)
  // The templates' keygen script runs in cmd.exe on Windows, which expands no ~.
  const home = join(workDir, 'home')
  const homed = runCli(['keygen', '--out', '~/.sprintengine/keys/demo.key'], workDir, {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  })
  assert.equal(homed.status, 0, homed.stderr)
  assert.match(homed.stdout, /fingerprint/i)
  assert.ok(existsSync(join(home, '.sprintengine', 'keys', 'demo.key')))
  assert.equal(existsSync(join(workDir, '~')), false)
})

test('an extension the CLI signed verifies through the SDK, naming the same signer', () => {
  const dir = writeExtensionFixture(validManifest())
  const before = readFileSync(join(dir, 'extension.json'), 'utf8')
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)
  assert.equal(readFileSync(join(dir, 'extension.json'), 'utf8'), before, 'sign never rewrites extension.json')

  const signature = readSignature(dir)
  const { valid, fingerprint } = verifyExtensionSignature(signature)
  assert.equal(valid, true)
  assert.deepEqual(moduleFileDigestIssuesSync(dir, signature.files, { walk: 'pack' }), [])

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /signature valid/)
  assert.ok(verified.stdout.includes(fingerprint!), 'the CLI reports the signer fingerprint the SDK computes')
})

test('a tampered extension is refused by the CLI and by the SDK, reading the same bytes', () => {
  const dir = writeExtensionFixture(validManifest())
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  const manifest = JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(
    join(dir, 'extension.json'),
    JSON.stringify({ ...manifest, permissions: ['storage:own', 'secrets:own'] }),
  )

  const cli = runCli(['verify', dir])
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /files\.extension\.json: does not match the signed digests/)

  const signature = readSignature(dir)
  assert.equal(verifyExtensionSignature(signature).valid, true, 'the signature is good over the digests it lists')
  assert.deepEqual(
    moduleFileDigestIssuesSync(dir, signature.files, { walk: 'pack' }).map((issue) => issue.path),
    ['files.extension.json'],
    'and the folder no longer matches them',
  )
})

test('verify says an unsigned extension is unsigned', () => {
  const verified = runCli(['verify', writeExtensionFixture(validManifest())])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /is unsigned/)
})

test('pack refuses an invalid manifest, naming the field and the fix', () => {
  const refused = (manifest: Record<string, unknown>, pattern: RegExp) => {
    const run = runCli(['pack', writeExtensionFixture(manifest), '--out', join(workDir, `packed-${fixtureCount++}`)])
    assert.equal(run.status, 1, run.stdout)
    assert.match(run.stderr, /Invalid extension manifest/)
    assert.match(run.stderr, pattern)
  }
  refused({ ...validManifest(), id: 'Bad_ID!' }, /id: must be kebab-case/)
  refused({ ...validManifest(), permissions: 'storage:own' }, /permissions: must be an array/)
  refused({ ...validManifest(), entry: { main: 'main.cjs' } }, /entry: is not a field Studio knows/)
  refused({ ...validManifest(), engines: { hostApi: 3 } }, /engines\.studio: is required/)
  refused({ ...validManifest(), tier: 'ui' }, /tier: "ui" cannot carry what this manifest declares/)

  const missing = writeExtensionFixture(validManifest())
  rmSync(join(missing, 'dist', 'notes.js'))
  const run = runCli(['pack', missing, '--out', join(workDir, `packed-${fixtureCount++}`)])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /contributes\.panels\[0\]\.entry: names "dist\/notes\.js", which does not exist/)

  const empty = join(workDir, `extension-${fixtureCount++}`)
  mkdirSync(empty)
  const none = runCli(['pack', empty])
  assert.equal(none.status, 1)
  assert.match(none.stderr, /No extension\.json/)
})

test('pack copies an installable folder, never key material, and the copy still verifies', () => {
  const dir = writeExtensionFixture(validManifest())
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  // A stray key inside the extension must not be distributed; sign left it out too.
  writeFileSync(join(dir, 'leaked-signing.key'), 'not really a key')
  const outDir = join(workDir, 'packed-fixture')
  const packed = runCli(['pack', dir, '--out', outDir])
  assert.equal(packed.status, 0, packed.stderr)
  for (const file of ['extension.json', 'extension.sig', 'main.cjs', 'dist/notes.js']) {
    assert.ok(existsSync(join(outDir, file)), file)
  }
  assert.equal(existsSync(join(outDir, 'leaked-signing.key')), false, 'key files are never packed')
  assert.equal(runCli(['verify', outDir]).status, 0)
  const installed = computeModuleFileDigestsSync(outDir)
  assert.ok(installed.ok, 'the packed copy is one Studio can digest as installed')

  assert.equal(runCli(['pack', dir, '--out', outDir]).status, 1, 'an existing output needs --force')
  assert.equal(runCli(['pack', dir, '--out', outDir, '--force']).status, 0)
  const inside = runCli(['pack', dir, '--out', join(dir, 'packed')])
  assert.equal(inside.status, 1)
  assert.match(inside.stderr, /outside the extension folder/)
})

test('the plugin bundle commands are gone: skills and MCP servers are contributions in extension.json', () => {
  const run = runCli(['plugin', 'scaffold', 'gone-plugin-fixture'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Unknown command "plugin"/)
})
