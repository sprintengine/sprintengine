// Trust classification for installed extensions, and for the signed
// manifests of plugin bundles and providers.
//
// The pure sign/verify logic and the walk that digests an extension's folder
// live in the published SDK (packages/extension-sdk/src/signing.ts) so the app
// and the `sprintengine-extension` CLI can never disagree about what a valid
// signature is or which files an extension ships; this module re-exports them
// and adds the app's trust policy on top.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  computeModuleFileDigestsSync,
  extensionContentFingerprint,
  manifestFingerprint,
  moduleFileDigestIssuesSync,
  parseExtensionSignature,
  verifyExtensionSignature,
  verifyModuleSignature,
  type SignedManifest,
} from '../../../packages/extension-sdk/src/signing'
import { compareModuleFileDigests } from '../../../packages/extension-sdk/src/manifest-validate'
import { EXTENSION_SIGNATURE_FILENAME } from '../../../packages/extension-sdk/src/extension-manifest'

import type { ModuleFileDigests, ModuleTrustStatus } from '../../shared/modules/manifest'

export type { ModuleTrustStatus } from '../../shared/modules/manifest'
export { manifestFingerprint, moduleFileDigestIssuesSync, verifyModuleSignature }
export type { SignedManifest }

export type ModuleTrustContext = {
  /**
   * The person's trust grants: install key → the content fingerprint of the
   * files they trusted (`extensionContentFingerprint`). A grant counts only
   * while the folder holds exactly those bytes, so a reinstall or an edit
   * reverts the extension to needing approval.
   */
  trustedModules: ReadonlyMap<string, string>
  /** Accepted publisher key fingerprints (trusted-publishers.json). */
  trustedKeyFingerprints?: ReadonlySet<string>
}

export type ModuleTrustIssue = { path: string; message: string }

export type ModuleTrust = {
  status: ModuleTrustStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  fingerprint?: string
  /** What made a 'trusted' extension trusted: its publisher's key, or the person's grant. */
  via?: 'publisher' | 'grant'
  /**
   * When 'trusted': the digests its files were verified against. The loader
   * and the window-code server hold the files to these again before using them.
   */
  verifiedFiles?: ModuleFileDigests
  /** The content fingerprint of the folder as it is, when every file could be digested. */
  contentFingerprint?: string
  /** The files do not match the digests extension.sig signs. */
  tampered?: boolean
  /** Why the extension's code is not vouched for, when that is what held it back. */
  issues?: ModuleTrustIssue[]
}

export type ExtensionContentResult =
  { ok: true; fingerprint: string; files: ModuleFileDigests } | { ok: false; issues: ModuleTrustIssue[] }

/** The content identity of an extension's folder, or why it has none (a symbolic link, a .git …). */
export function extensionContentSync(root: string): ExtensionContentResult {
  const scan = computeModuleFileDigestsSync(root)
  if (!scan.ok) return { ok: false, issues: scan.issues }
  return { ok: true, fingerprint: extensionContentFingerprint(scan.files), files: scan.files }
}

/**
 * Trust for an installed extension, decided from the bytes on disk now.
 *
 * - With extension.sig: a bad signature, or files that do not match the
 *   digests it signs, is 'invalid' whoever signed it. A good signature by a
 *   trusted publisher key is 'trusted'; by any other key, 'signed'.
 * - Without: 'unsigned'.
 * - A signed or unsigned extension is 'trusted' by the person's grant when the
 *   grant names exactly the content the folder holds.
 */
export function classifyExtensionTrust(root: string, key: string, ctx: ModuleTrustContext): ModuleTrust {
  const scan = computeModuleFileDigestsSync(root)
  const contentFingerprint = scan.ok ? extensionContentFingerprint(scan.files) : undefined
  const content = contentFingerprint ? { contentFingerprint } : {}
  const sigPath = join(root, EXTENSION_SIGNATURE_FILENAME)
  let signer: string | undefined
  let publisherKey = false
  if (existsSync(sigPath)) {
    let source: string
    try {
      source = readFileSync(sigPath, 'utf8')
    } catch {
      return { status: 'invalid', issues: [{ path: EXTENSION_SIGNATURE_FILENAME, message: 'could not be read.' }] }
    }
    const parsed = parseExtensionSignature(source)
    if (!parsed.ok)
      return { status: 'invalid', issues: [{ path: EXTENSION_SIGNATURE_FILENAME, message: parsed.message }] }
    const { valid, fingerprint } = verifyExtensionSignature(parsed.signature)
    if (!valid) return { status: 'invalid', fingerprint }
    const issues = [...(scan.ok ? [] : scan.issues), ...compareModuleFileDigests(parsed.signature.files, scan.files)]
    if (issues.length > 0) return { status: 'invalid', fingerprint, tampered: true, issues }
    signer = fingerprint
    publisherKey = fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
  }
  const untrusted: ModuleTrustStatus = signer !== undefined ? 'signed' : 'unsigned'
  if (!scan.ok) return { status: untrusted, fingerprint: signer, issues: scan.issues }
  if (publisherKey) {
    return { status: 'trusted', fingerprint: signer, via: 'publisher', verifiedFiles: scan.files, ...content }
  }
  if (ctx.trustedModules.get(key) === contentFingerprint) {
    return { status: 'trusted', fingerprint: signer, via: 'grant', verifiedFiles: scan.files, ...content }
  }
  return { status: untrusted, fingerprint: signer, ...content }
}

// Trust for a manifest alone — a plugin bundle's plugin.json or a provider
// manifest, whose bytes are covered by per-component digests checked
// separately. Never use it for an extension on disk: it does not look at the
// extension's code (classifyExtensionTrust does).
export function classifySignedManifestTrust(manifest: SignedManifest, ctx: ModuleTrustContext): ModuleTrust {
  // Trust is honored only if the user trusted *this exact* manifest content.
  const idTrusted = ctx.trustedModules.get(manifest.id) === manifestFingerprint(manifest)
  if (!manifest.signature) {
    return idTrusted ? { status: 'trusted' } : { status: 'unsigned' }
  }
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) return { status: 'invalid', fingerprint }
  const keyAccepted = fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
  if (idTrusted || keyAccepted) return { status: 'trusted', fingerprint }
  return { status: 'signed', fingerprint }
}

// Whether a bundle manifest carries a valid signature by a trusted publisher
// key: a statement about the manifest only.
export function isSignedByTrustedPublisher(manifest: SignedManifest, ctx: ModuleTrustContext): boolean {
  if (!manifest.signature) return false
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  return valid && fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
}

// Only fully-trusted extensions are eligible to load; everything else is gated.
export function isLoadEligible(trust: ModuleTrustStatus): boolean {
  return trust === 'trusted'
}
