// Signing: ed25519 over an extension's file digests (`extension.sig`), and
// over a plugin bundle's canonical manifest payload.
//
// Subpath export `@sprintengine/extension-sdk/signing` (not part of the root index:
// this file needs node:crypto, and the root index must stay loadable in a
// renderer). The studio's signature verification
// (src/main/modules/module-signature.ts) and the `sprintengine-extension` CLI both
// consume these functions, so signer and verifier can never disagree about
// what a valid signature is.
//
// A bundle signature is a detached ed25519 signature over
// canonicalManifestPayload (the validated plugin.json minus its `signature`
// field, sorted-key JSON). An extension's is `extension.sig`, below. The walk
// that digests an extension's folder is re-exported here from module-files.ts.
// Public API uses only strings (PEM / base64) so the published declaration
// surface carries no Node type dependency.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

import { EXTENSION_MANIFEST_FILENAME, EXTENSION_SIGNATURE_FILENAME } from './extension-manifest.js'
import type { ModuleFileDigests, ModuleSignature } from './index.js'
import { canonicalJsonStringify, canonicalManifestPayload, isSafeManifestRelativePath } from './manifest-validate.js'

export {
  computeModuleFileDigestsSync,
  moduleFileDigestIssuesSync,
  type ModuleFileDigestOptions,
  type ModuleFileDigestsResult,
  type ModuleFileWalk,
} from './module-files.js'

/** The minimum a manifest needs for signature work; full manifests satisfy it. */
export type SignedManifest = {
  id: string
  signature?: ModuleSignature
}

// A content fingerprint of a bundle manifest's security-relevant declaration
// (everything except the signature itself): what a trust grant for a bundle
// or a provider manifest binds to.
export function manifestFingerprint(manifest: SignedManifest): string {
  return createHash('sha256').update(canonicalManifestPayload(manifest)).digest('hex')
}

/** sha256 hex of the signer's normalized (SPKI DER) public key; undefined when malformed. */
export function publicKeyFingerprint(publicKeyB64: string): string | undefined {
  try {
    const der = Buffer.from(publicKeyB64, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const normalized = key.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(normalized).digest('hex')
  } catch {
    return undefined
  }
}

// Verify the detached ed25519 signature over the canonical manifest payload
// (the manifest minus its signature field). Returns whether it's valid plus the
// signer's key fingerprint. Any malformed key/signature is treated as invalid,
// never thrown.
export function verifyModuleSignature(manifest: SignedManifest): { valid: boolean; fingerprint?: string } {
  const sig = manifest.signature
  if (!sig) return { valid: false }
  try {
    const der = Buffer.from(sig.publicKey, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
    const valid = verify(null, payload, key, Buffer.from(sig.signature, 'base64'))
    return { valid, fingerprint: publicKeyFingerprint(sig.publicKey) }
  } catch {
    return { valid: false }
  }
}

export type ModuleSigningKeyPair = {
  /** PKCS#8 PEM — the secret. Keep it out of the extension's folder and out of git. */
  privateKeyPem: string
  /** Base64 SPKI DER — what lands in extension.sig's publicKey. */
  publicKeyB64: string
  /** sha256 hex of the public key, as the app's trust UI displays it. */
  fingerprint: string
}

export function generateModuleSigningKeyPair(): ModuleSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyB64,
    // The key was just exported in normalized form, so the fingerprint cannot
    // be undefined; the fallback only guards the type.
    fingerprint: publicKeyFingerprint(publicKeyB64) ?? '',
  }
}

// Produce the detached signature for a validated bundle manifest. The caller
// must pass the manifest in its VALIDATED shape (validateBundleBaseManifest
// output): the app verifies over that shape, so signing anything else (for
// example the raw file JSON with unknown keys) yields a signature the app
// rejects. Throws on a malformed private key — explicit failure, no fallback.
export function signManifest(manifest: SignedManifest, privateKeyPem: string): ModuleSignature {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Signing key must be ed25519, got ${key.asymmetricKeyType ?? 'unknown'}.`)
  }
  const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
  const signature = sign(null, payload, key).toString('base64')
  const publicKeyB64 = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  return { algorithm: 'ed25519', publicKey: publicKeyB64, signature }
}

// ── extension.sig ───────────────────────────────────────────────────────────
// An extension is signed by a detached file beside its manifest,
// `extension.sig`: the sha256 of every file it ships (extension.json
// included, extension.sig itself left out), the signer's public key, and an
// ed25519 signature over those digests. The digests cover the manifest as a
// file like any other, so the signature vouches for the declaration and the
// code together.

/** What `extension.sig` holds. */
export type ExtensionSignature = {
  files: ModuleFileDigests
  publicKey: string
  signature: string
}

// A tag in front of the signed bytes, so a signature made for an extension can
// never be passed off as one over a bundle manifest, or the other way round.
const EXTENSION_SIGNATURE_DOMAIN = 'sprintengine-extension-signature:1\n'

function extensionSignaturePayload(files: ModuleFileDigests): Buffer {
  return Buffer.from(`${EXTENSION_SIGNATURE_DOMAIN}${canonicalJsonStringify(files)}`, 'utf8')
}

/**
 * The content identity of an extension: sha256 over its sorted file digests.
 * What a person's trust grant binds to, so different bytes under the same
 * install key never inherit it.
 */
export function extensionContentFingerprint(files: ModuleFileDigests): string {
  return createHash('sha256').update(canonicalJsonStringify(files)).digest('hex')
}

/** Read `extension.sig`'s text, or say why it is not one. Pure. */
export function parseExtensionSignature(
  source: string,
): { ok: true; signature: ExtensionSignature } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return { ok: false, message: 'extension.sig is not JSON.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'extension.sig must be a JSON object.' }
  }
  const record = parsed as Record<string, unknown>
  const unknownKey = Object.keys(record).find((key) => !['files', 'publicKey', 'signature'].includes(key))
  if (unknownKey) return { ok: false, message: `extension.sig has a field Studio does not read: ${unknownKey}.` }
  const base64 = /^[A-Za-z0-9+/]+={0,2}$/
  if (typeof record.publicKey !== 'string' || !base64.test(record.publicKey)) {
    return { ok: false, message: 'extension.sig: publicKey must be base64.' }
  }
  if (typeof record.signature !== 'string' || !base64.test(record.signature)) {
    return { ok: false, message: 'extension.sig: signature must be base64.' }
  }
  const files = record.files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return { ok: false, message: 'extension.sig: files must map each path to its sha256.' }
  }
  const out: ModuleFileDigests = {}
  for (const path of Object.keys(files).sort()) {
    const digest = (files as Record<string, unknown>)[path]
    if (!isSafeManifestRelativePath(path) || path === EXTENSION_SIGNATURE_FILENAME) {
      return { ok: false, message: `extension.sig lists a path no extension can hold: ${path}.` }
    }
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      return { ok: false, message: `extension.sig: ${path} must have a lowercase sha256 hex digest.` }
    }
    out[path] = digest
  }
  if (out[EXTENSION_MANIFEST_FILENAME] === undefined) {
    return { ok: false, message: 'extension.sig does not cover extension.json.' }
  }
  return { ok: true, signature: { files: out, publicKey: record.publicKey, signature: record.signature } }
}

/** Whether `extension.sig`'s signature is good over its own digests, and whose key made it. */
export function verifyExtensionSignature(signature: ExtensionSignature): { valid: boolean; fingerprint?: string } {
  try {
    const key = createPublicKey({ key: Buffer.from(signature.publicKey, 'base64'), format: 'der', type: 'spki' })
    const valid = verify(
      null,
      extensionSignaturePayload(signature.files),
      key,
      Buffer.from(signature.signature, 'base64'),
    )
    return { valid, fingerprint: publicKeyFingerprint(signature.publicKey) }
  } catch {
    return { valid: false }
  }
}

/** Sign an extension's file digests. Throws on a key that is not ed25519. */
export function signExtensionFiles(files: ModuleFileDigests, privateKeyPem: string): ExtensionSignature {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Signing key must be ed25519, got ${key.asymmetricKeyType ?? 'unknown'}.`)
  }
  const sorted: ModuleFileDigests = {}
  for (const path of Object.keys(files).sort()) sorted[path] = files[path]!
  return {
    files: sorted,
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    signature: sign(null, extensionSignaturePayload(sorted), key).toString('base64'),
  }
}
