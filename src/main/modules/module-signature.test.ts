import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { generateModuleSigningKeyPair, signManifest } from '../../../packages/extension-sdk/src/signing'
import { newExtensionSigner, signExtensionFolder, writeExtensionFolder } from '../../../tests/extension-folder'
import {
  classifyExtensionTrust,
  classifySignedManifestTrust,
  extensionContentSync,
  isLoadEligible,
  manifestFingerprint,
  verifyModuleSignature,
  type ModuleTrustContext,
} from './module-signature'

const KEY = 'acme.demo'
const NO_TRUST: ModuleTrustContext = { trustedModules: new Map() }
const EVIL_SOURCE = 'require("child_process").exec("curl evil")\n'

// An installed extension's folder: extension.json and dist/main.cjs.
function withTemp(fn: (root: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), 'mc-module-signature-'))
  try {
    fn(writeExtensionFolder(join(parent, KEY)))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function contentFingerprint(root: string): string {
  const content = extensionContentSync(root)
  assert.ok(content.ok)
  return content.fingerprint
}

test('an extension without extension.sig is unsigned, with its content fingerprint', () => {
  withTemp((root) => {
    const trust = classifyExtensionTrust(root, KEY, NO_TRUST)
    assert.equal(trust.status, 'unsigned')
    assert.equal(trust.fingerprint, undefined)
    assert.equal(trust.verifiedFiles, undefined)
    assert.equal(trust.contentFingerprint, contentFingerprint(root))
    assert.equal(isLoadEligible(trust.status), false)
  })
})

test('a good signature by a key nobody trusts is signed, not trusted', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const trust = classifyExtensionTrust(root, KEY, NO_TRUST)
    assert.equal(trust.status, 'signed')
    assert.equal(trust.fingerprint, signer.fingerprint)
    assert.equal(trust.verifiedFiles, undefined)
  })
})

test('a good signature by a trusted publisher key is trusted via the publisher', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const trust = classifyExtensionTrust(root, KEY, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'trusted')
    assert.equal(trust.via, 'publisher')
    assert.equal(trust.fingerprint, signer.fingerprint)
    // extension.sig itself is not one of the files it vouches for.
    assert.deepEqual(Object.keys(trust.verifiedFiles ?? {}), ['dist/main.cjs', 'extension.json'])
    assert.equal(trust.contentFingerprint, contentFingerprint(root))
  })
})

test('a grant trusts exactly the content it names, and a changed file loses it', () => {
  withTemp((root) => {
    const ctx: ModuleTrustContext = { trustedModules: new Map([[KEY, contentFingerprint(root)]]) }
    const trusted = classifyExtensionTrust(root, KEY, ctx)
    assert.equal(trusted.status, 'trusted')
    assert.equal(trusted.via, 'grant')
    assert.deepEqual(Object.keys(trusted.verifiedFiles ?? {}), ['dist/main.cjs', 'extension.json'])

    // The grant is per install key: the same bytes under another key are not trusted.
    assert.equal(classifyExtensionTrust(root, 'local.demo', ctx).status, 'unsigned')

    writeFileSync(join(root, 'dist', 'main.cjs'), EVIL_SOURCE)
    const swapped = classifyExtensionTrust(root, KEY, ctx)
    assert.equal(swapped.status, 'unsigned')
    assert.equal(swapped.verifiedFiles, undefined)
  })
})

test('a grant also trusts a signed extension whose key nobody trusts', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const trust = classifyExtensionTrust(root, KEY, { trustedModules: new Map([[KEY, contentFingerprint(root)]]) })
    assert.equal(trust.status, 'trusted')
    assert.equal(trust.via, 'grant')
    assert.equal(trust.fingerprint, signer.fingerprint)
  })
})

test('a bad signature is invalid, whatever is granted or trusted', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    const sigPath = join(root, 'extension.sig')
    const sig = JSON.parse(readFileSync(sigPath, 'utf8')) as { signature: string }
    // Another key's signature over the same digests does not verify under this public key.
    const other = generateModuleSigningKeyPair()
    const forged = signManifest({ id: 'demo' }, other.privateKeyPem).signature
    writeFileSync(sigPath, JSON.stringify({ ...sig, signature: forged }))
    const trust = classifyExtensionTrust(root, KEY, {
      trustedModules: new Map([[KEY, contentFingerprint(root)]]),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.equal(trust.tampered, undefined)
    assert.equal(isLoadEligible(trust.status), false)
  })
})

test('an extension.sig that is not one is invalid', () => {
  withTemp((root) => {
    writeFileSync(join(root, 'extension.sig'), 'not json')
    const trust = classifyExtensionTrust(root, KEY, NO_TRUST)
    assert.equal(trust.status, 'invalid')
    assert.deepEqual(trust.issues, [{ path: 'extension.sig', message: 'extension.sig is not JSON.' }])
  })
})

test('a changed file under signed digests is invalid and tampered', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    writeFileSync(join(root, 'dist', 'main.cjs'), EVIL_SOURCE)
    const trust = classifyExtensionTrust(root, KEY, {
      trustedModules: new Map([[KEY, contentFingerprint(root)]]),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.equal(trust.tampered, true)
    assert.deepEqual(trust.issues, [{ path: 'files.dist/main.cjs', message: 'does not match the signed digests.' }])
  })
})

test('a file the signed digests do not list is invalid and tampered', () => {
  withTemp((root) => {
    const signer = newExtensionSigner()
    signExtensionFolder(root, signer)
    writeFileSync(join(root, 'dist', 'payload.cjs'), 'module.exports = 1\n')
    const trust = classifyExtensionTrust(root, KEY, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.equal(trust.tampered, true)
    assert.deepEqual(trust.issues, [
      { path: 'files.dist/payload.cjs', message: 'is not listed in the signed digests.' },
    ])
  })
})

test('a symbolic link in the folder leaves it without a content fingerprint, so nothing trusts it', () => {
  withTemp((root) => {
    const before = contentFingerprint(root)
    writeFileSync(join(root, '..', 'elsewhere.cjs'), EVIL_SOURCE)
    symlinkSync(join(root, '..', 'elsewhere.cjs'), join(root, 'dist', 'linked.cjs'))
    assert.equal(extensionContentSync(root).ok, false)
    const trust = classifyExtensionTrust(root, KEY, { trustedModules: new Map([[KEY, before]]) })
    assert.equal(trust.status, 'unsigned')
    assert.equal(trust.contentFingerprint, undefined)
    assert.ok(trust.issues?.some((issue) => /symbolic link/.test(issue.message)))
  })
})

test('manifest-only trust for bundle manifests binds to the manifest fingerprint or a publisher key', () => {
  const unsigned = { id: 'bundle', name: 'Bundle', version: '1.0.0' }
  assert.equal(classifySignedManifestTrust(unsigned, NO_TRUST).status, 'unsigned')
  assert.equal(
    classifySignedManifestTrust(unsigned, { trustedModules: new Map([[unsigned.id, manifestFingerprint(unsigned)]]) })
      .status,
    'trusted',
  )
  const signer = generateModuleSigningKeyPair()
  const signed = { ...unsigned, signature: signManifest(unsigned, signer.privateKeyPem) }
  const renamed = { ...signed, name: 'Evil' }
  assert.equal(verifyModuleSignature(signed).valid, true)
  assert.equal(verifyModuleSignature(renamed).valid, false)
  assert.equal(classifySignedManifestTrust(signed, NO_TRUST).status, 'signed')
  assert.equal(
    classifySignedManifestTrust(signed, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    }).status,
    'trusted',
  )
  assert.equal(classifySignedManifestTrust(renamed, NO_TRUST).status, 'invalid')
})

test('only trusted is load eligible', () => {
  assert.equal(isLoadEligible('trusted'), true)
  assert.equal(isLoadEligible('signed'), false)
  assert.equal(isLoadEligible('unsigned'), false)
  assert.equal(isLoadEligible('invalid'), false)
})
