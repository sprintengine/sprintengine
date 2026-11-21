// The walk that digests an extension's folder: what `sign` records in
// extension.sig, and what Studio checks again before it loads the code. Every
// file counts, extension.json included; only extension.sig is left out.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { compareModuleFileDigests, isPackExcludedPath } from '../src/manifest-validate.js'
import { computeModuleFileDigestsSync, moduleFileDigestIssuesSync } from '../src/signing.js'

const DIGEST = 'a'.repeat(64)

function tempExtension(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-module-files-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

test('comparison is an exact set: missing, changed and unlisted files all count', () => {
  const issues = compareModuleFileDigests(
    { 'a.cjs': DIGEST, 'b.cjs': DIGEST },
    { 'a.cjs': 'b'.repeat(64), 'c.cjs': DIGEST },
  )
  assert.deepEqual(issues, [
    { path: 'files.a.cjs', message: 'does not match the signed digests.' },
    { path: 'files.b.cjs', message: 'listed in the signed digests but missing.' },
    { path: 'files.c.cjs', message: 'is not listed in the signed digests.' },
  ])
})

test('the walk digests every file but extension.sig, extension.json included', () => {
  const root = tempExtension({
    'extension.json': '{}',
    'extension.sig': '{}',
    'dist/main.cjs': 'x',
    'dist/extension.sig': 'a nested one is just a file',
  })
  const result = computeModuleFileDigestsSync(root)
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.issues))
  assert.deepEqual(Object.keys(result.files), ['dist/extension.sig', 'dist/main.cjs', 'extension.json'])
  assert.match(result.files['extension.json']!, /^[a-f0-9]{64}$/)
  assert.deepEqual(moduleFileDigestIssuesSync(root, result.files), [])
})

test('a changed or added file is a mismatch against the digests it is held to', () => {
  const root = tempExtension({ 'extension.json': '{}', 'dist/main.cjs': 'x' })
  const before = computeModuleFileDigestsSync(root)
  assert.ok(before.ok)
  writeFileSync(join(root, 'extension.json'), '{"id":"changed"}')
  writeFileSync(join(root, 'dist', 'extra.js'), 'y')
  assert.deepEqual(
    moduleFileDigestIssuesSync(root, before.files).map((issue) => issue.path),
    ['files.extension.json', 'files.dist/extra.js'],
  )
})

test('the pack walk leaves out what pack leaves out; the installed walk refuses it', () => {
  const root = tempExtension({ 'main.cjs': 'x', 'node_modules/dep/index.js': 'y', '.git/HEAD': 'z', 'dev.pem': 'k' })
  const packView = computeModuleFileDigestsSync(root, { walk: 'pack' })
  assert.ok(packView.ok)
  assert.deepEqual(Object.keys(packView.files), ['main.cjs'])
  const installed = computeModuleFileDigestsSync(root)
  assert.equal(installed.ok, false)
  if (!installed.ok) {
    assert.deepEqual(
      installed.issues.map((issue) => issue.path),
      ['files..git', 'files.dev.pem', 'files.node_modules'],
    )
  }
  for (const path of ['node_modules/x/index.js', '.git/HEAD', 'signing.key', 'certs/tls.pem']) {
    assert.equal(isPackExcludedPath(path), true, path)
  }
  assert.equal(isPackExcludedPath('dist/keys.js'), false)
})

test('a symbolic link is refused, never followed', () => {
  const root = tempExtension({ 'extension.json': '{}' })
  const outside = tempExtension({ 'secret.js': 'x' })
  symlinkSync(join(outside, 'secret.js'), join(root, 'linked.js'))
  const result = computeModuleFileDigestsSync(root, { walk: 'pack' })
  assert.equal(result.ok, false)
  if (!result.ok)
    assert.deepEqual(result.issues, [
      { path: 'files.linked.js', message: 'is a symbolic link; an extension ships regular files only.' },
    ])
})

test('a missing extension folder is an issue, not an empty extension', () => {
  const result = computeModuleFileDigestsSync(join(tmpdir(), 'sdk-module-files-does-not-exist'))
  assert.equal(result.ok, false)
})
