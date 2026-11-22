import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { generateModuleSigningKeyPair, signManifest } from '../../../packages/extension-sdk/src/signing'
import {
  extensionManifest,
  newExtensionSigner,
  signExtensionFolder,
  writeExtensionFolder,
} from '../../../tests/extension-folder'
import { parseExtensionManifest } from '../../shared/modules/third-party-manifest'
import { approvalOf, approvedContext } from './extension-approvals.test-helper'
import {
  classifyExtension,
  extensionContentSync,
  isExtensionRunnable,
  type ExtensionStandingContext,
} from './module-signature'

const KEY = 'acme.demo'
const NOTHING_APPROVED: ExtensionStandingContext = { approvals: new Map() }
const EVIL_SOURCE = 'require("child_process").exec("curl evil")\n'

// An installed extension's folder: extension.json and dist/main.cjs.
function withTemp(fn: (root: string) => void, manifest = extensionManifest()): void {
  const parent = mkdtempSync(join(tmpdir(), 'mc-module-signature-'))
  try {
    fn(writeExtensionFolder(join(parent, KEY), { manifest }))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function manifestOf(root: string) {
  const parsed = parseExtensionManifest(readFileSync(join(root, 'extension.json'), 'utf8'))
  assert.ok(parsed.ok)
  return parsed.manifest
}

const classify = (root: string, ctx: ExtensionStandingContext, key = KEY) =>
  classifyExtension(root, key, manifestOf(root), ctx)

test('an extension without extension.sig is unsigned and waits for approval of its fingerprint', () => {
  withTemp((root) => {
    const standing = classify(root, NOTHING_APPROVED)
    assert.equal(standing.signature, 'unsigned')
    assert.equal(standing.signer, undefined)
    const content = extensionContentSync(root)
    assert.ok(content.ok)
    assert.equal(standing.contentDigest, content.fingerprint)
    assert.deepEqual(standing.approval, {
      state: 'pending',
      fingerprint: approvalOf(root).fingerprint,
      growth: [],
      reapproval: false,
    })
    assert.equal(isExtensionRunnable(standing), false)
  })
})

test('a good signature by a key nobody trusts is signed; by a trusted key, verified; neither approves', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const signed = classify(root, NOTHING_APPROVED)
    assert.equal(signed.signature, 'signed')
    assert.equal(signed.signer, signer.fingerprint)
    const verified = classify(root, { approvals: new Map(), trustedKeyFingerprints: new Set([signer.fingerprint]) })
    assert.equal(verified.signature, 'verified')
    assert.equal(verified.approval.state, 'pending')
    assert.equal(isExtensionRunnable(verified), false)
  })
})

test('an approval runs exactly what it names, under its install key, and a changed file loses it', () => {
  withTemp((root) => {
    const ctx = approvedContext({ [KEY]: root })
    const approved = classify(root, ctx)
    assert.equal(approved.approval.state, 'approved')
    assert.equal(isExtensionRunnable(approved), true)
    // extension.sig is not one of the files; the rest are verified.
    assert.deepEqual(Object.keys(approved.verifiedFiles ?? {}), ['dist/main.cjs', 'extension.json'])

    // The approval is per install key: the same bytes under another key wait.
    assert.equal(classify(root, ctx, 'local.demo').approval.state, 'pending')

    writeFileSync(join(root, 'dist', 'main.cjs'), EVIL_SOURCE)
    const swapped = classify(root, ctx)
    assert.equal(swapped.approval.state, 'pending')
    assert.equal(isExtensionRunnable(swapped), false)
  })
})

test('a pending update says what it asks beyond the approved version', () => {
  withTemp((root) => {
    const ctx = approvedContext({ [KEY]: root })
    writeFileSync(
      join(root, 'extension.json'),
      JSON.stringify(extensionManifest({ permissions: ['storage:own', 'github:api'], background: true })),
    )
    const standing = classify(root, ctx)
    assert.equal(standing.approval.state, 'pending')
    if (standing.approval.state !== 'pending') return
    assert.equal(standing.approval.reapproval, true)
    assert.deepEqual(standing.approval.growth, ['the "github:api" permission', 'a worker that runs in the background'])
  })
})

test('an extension that only carries content needs no approval', () => {
  withTemp(
    (root) => {
      const standing = classify(root, NOTHING_APPROVED)
      assert.deepEqual(standing.approval, { state: 'not-needed' })
      assert.equal(isExtensionRunnable(standing), true)
    },
    extensionManifest({ tier: 'content', permissions: [], main: undefined }),
  )
})

test('a bad signature is invalid and never runs, whatever is approved or trusted', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const sigPath = join(root, 'extension.sig')
    const sig = JSON.parse(readFileSync(sigPath, 'utf8')) as { signature: string }
    // Another key's signature over the same digests does not verify under this public key.
    const other = generateModuleSigningKeyPair()
    const forged = signManifest({ id: 'demo' }, other.privateKeyPem).signature
    writeFileSync(sigPath, JSON.stringify({ ...sig, signature: forged }))
    const standing = classify(root, {
      ...approvedContext({ [KEY]: root }),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(standing.signature, 'invalid')
    assert.equal(standing.tampered, undefined)
    assert.equal(isExtensionRunnable(standing), false)
  })
})

test('an extension.sig that is not one is invalid', () => {
  withTemp((root) => {
    writeFileSync(join(root, 'extension.sig'), 'not json')
    const standing = classify(root, NOTHING_APPROVED)
    assert.equal(standing.signature, 'invalid')
    assert.deepEqual(standing.issues, [{ path: 'extension.sig', message: 'extension.sig is not JSON.' }])
  })
})

test('a changed or an extra file under signed digests is invalid and tampered', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    writeFileSync(join(root, 'dist', 'main.cjs'), EVIL_SOURCE)
    writeFileSync(join(root, 'dist', 'payload.cjs'), 'module.exports = 1\n')
    const standing = classify(root, { approvals: new Map(), trustedKeyFingerprints: new Set([signer.fingerprint]) })
    assert.equal(standing.signature, 'invalid')
    assert.equal(standing.tampered, true)
    assert.deepEqual(standing.issues, [
      { path: 'files.dist/main.cjs', message: 'does not match the signed digests.' },
      { path: 'files.dist/payload.cjs', message: 'is not listed in the signed digests.' },
    ])
  })
})

test('a symbolic link in the folder leaves nothing to approve, so it does not run', () => {
  withTemp((root) => {
    const ctx = approvedContext({ [KEY]: root })
    writeFileSync(join(root, '..', 'elsewhere.cjs'), EVIL_SOURCE)
    symlinkSync(join(root, '..', 'elsewhere.cjs'), join(root, 'dist', 'linked.cjs'))
    assert.equal(extensionContentSync(root).ok, false)
    const standing = classify(root, ctx)
    assert.deepEqual(standing.approval, { state: 'unavailable' })
    assert.equal(standing.contentDigest, undefined)
    assert.equal(isExtensionRunnable(standing), false)
    assert.ok(standing.issues?.some((issue) => /symbolic link/.test(issue.message)))
  })
})
