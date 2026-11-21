// extension.sig: the sha256 of every file an extension ships, the signer's
// public key, and an ed25519 signature over those digests. What a signature
// vouches for is the declaration and the code together, so a change to any
// byte, a file added, or another key's signature all fail.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import {
  computeModuleFileDigestsSync,
  extensionContentFingerprint,
  generateModuleSigningKeyPair,
  parseExtensionSignature,
  publicKeyFingerprint,
  signExtensionFiles,
  verifyExtensionSignature,
  type ExtensionSignature,
} from '../src/signing.js'

const DIGEST = 'a'.repeat(64)

function extensionFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-extension-sig-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'extension.json'), '{"id":"notes"}\n')
  writeFileSync(join(root, 'dist', 'notes.js'), 'export function mount() {}\n')
  writeFileSync(join(root, 'dist', 'main.cjs'), 'exports.activate = () => {}\n')
  return root
}

function digests(root: string) {
  const result = computeModuleFileDigestsSync(root, { walk: 'pack' })
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.issues))
  return result.files
}

test('a signature over an extension’s files verifies, names its signer, and reads back from its text', () => {
  const root = extensionFolder()
  const key = generateModuleSigningKeyPair()
  const signature = signExtensionFiles(digests(root), key.privateKeyPem)
  assert.deepEqual(Object.keys(signature.files), ['dist/main.cjs', 'dist/notes.js', 'extension.json'])
  assert.equal(signature.publicKey, key.publicKeyB64)
  assert.deepEqual(verifyExtensionSignature(signature), { valid: true, fingerprint: key.fingerprint })

  const parsed = parseExtensionSignature(JSON.stringify(signature, null, 2))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message)
  if (parsed.ok) {
    assert.deepEqual(parsed.signature, signature)
    assert.equal(verifyExtensionSignature(parsed.signature).valid, true)
  }
})

test('signing sorts the digests, so the order they came in does not matter', () => {
  const key = generateModuleSigningKeyPair()
  const signature = signExtensionFiles({ 'extension.json': DIGEST, 'dist/a.js': DIGEST }, key.privateKeyPem)
  assert.deepEqual(Object.keys(signature.files), ['dist/a.js', 'extension.json'])
})

test('a changed digest, an added file or a removed one breaks the signature', () => {
  const root = extensionFolder()
  const key = generateModuleSigningKeyPair()
  const signature = signExtensionFiles(digests(root), key.privateKeyPem)

  const changed: ExtensionSignature = { ...signature, files: { ...signature.files, 'dist/notes.js': DIGEST } }
  assert.equal(verifyExtensionSignature(changed).valid, false)
  const added: ExtensionSignature = { ...signature, files: { ...signature.files, 'dist/extra.js': DIGEST } }
  assert.equal(verifyExtensionSignature(added).valid, false)
  const { 'dist/main.cjs': _main, ...rest } = signature.files
  assert.equal(verifyExtensionSignature({ ...signature, files: rest }).valid, false)
})

test('another key’s public key, or an altered signature, does not verify', () => {
  const files = digests(extensionFolder())
  const key = generateModuleSigningKeyPair()
  const other = generateModuleSigningKeyPair()
  const signature = signExtensionFiles(files, key.privateKeyPem)

  assert.equal(verifyExtensionSignature({ ...signature, publicKey: other.publicKeyB64 }).valid, false)
  const theirs = signExtensionFiles(files, other.privateKeyPem)
  assert.equal(verifyExtensionSignature({ ...signature, signature: theirs.signature }).valid, false)

  const bytes = Buffer.from(signature.signature, 'base64')
  bytes[0] = bytes[0]! ^ 0xff
  assert.equal(verifyExtensionSignature({ ...signature, signature: bytes.toString('base64') }).valid, false)
  // Malformed rather than wrong: answered, never thrown.
  assert.deepEqual(verifyExtensionSignature({ ...signature, publicKey: 'AAAA' }), { valid: false })
})

test('a key that is not ed25519 is refused when signing', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(() => signExtensionFiles({ 'extension.json': DIGEST }, pem), /must be ed25519, got ec/)
})

test('parseExtensionSignature refuses what is not an extension.sig', () => {
  const key = generateModuleSigningKeyPair()
  const good = signExtensionFiles({ 'extension.json': DIGEST, 'dist/a.js': DIGEST }, key.privateKeyPem)
  const refused = (value: unknown, pattern: RegExp) => {
    const result = parseExtensionSignature(typeof value === 'string' ? value : JSON.stringify(value))
    assert.equal(result.ok, false, JSON.stringify(value))
    if (!result.ok) assert.match(result.message, pattern)
  }
  refused('{ not json', /is not JSON/)
  refused([], /must be a JSON object/)
  refused({ ...good, algorithm: 'ed25519' }, /a field Studio does not read: algorithm/)
  refused({ ...good, publicKey: 'not base64!' }, /publicKey must be base64/)
  refused({ ...good, signature: 42 }, /signature must be base64/)
  refused({ ...good, files: ['extension.json'] }, /files must map each path/)
  for (const path of ['../escape.js', '/etc/passwd', 'dist\\a.js', 'dist/./a.js', 'extension.sig']) {
    refused({ ...good, files: { ...good.files, [path]: DIGEST } }, /a path no extension can hold/)
  }
  for (const digest of ['A'.repeat(64), 'a'.repeat(63), 42]) {
    refused({ ...good, files: { ...good.files, 'dist/a.js': digest } }, /lowercase sha256 hex digest/)
  }
  refused({ ...good, files: { 'dist/a.js': DIGEST } }, /does not cover extension\.json/)
})

test('the content fingerprint ignores the order of the digests and changes with any byte', () => {
  const root = extensionFolder()
  const files = digests(root)
  const reversed = Object.fromEntries(Object.entries(files).reverse())
  assert.equal(extensionContentFingerprint(reversed), extensionContentFingerprint(files))
  assert.match(extensionContentFingerprint(files), /^[a-f0-9]{64}$/)

  writeFileSync(join(root, 'dist', 'notes.js'), 'export function mount() {} \n')
  assert.notEqual(extensionContentFingerprint(digests(root)), extensionContentFingerprint(files))
})

test('the signer fingerprint is the sha256 of its public key, and a malformed key has none', () => {
  const key = generateModuleSigningKeyPair()
  assert.equal(publicKeyFingerprint(key.publicKeyB64), key.fingerprint)
  assert.match(key.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(publicKeyFingerprint('AAAA'), undefined)
})
