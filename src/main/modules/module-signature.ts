// What vouches for an installed extension, and for the signed manifests of
// plugin bundles and providers.
//
// The pure sign/verify logic and the walk that digests an extension's folder
// live in the published SDK (packages/extension-sdk/src/signing.ts) so the app
// and the `sprintengine-extension` CLI can never disagree about what a valid
// signature is or which files an extension ships; this module re-exports them
// and adds the app's policy on top. For an extension, a signature is a badge
// (`verified` by a publisher key Studio trusts); what lets it run is the
// person's approval (extension-approvals.ts).

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
import type { ExtensionManifest } from '../../shared/modules/third-party-manifest'
import {
  accessGrowth,
  extensionAccess,
  extensionApprovalFingerprint,
  extensionNeedsApproval,
  type ExtensionApprovalRecord,
} from './extension-approvals'

export type { ModuleTrustStatus } from '../../shared/modules/manifest'
export { manifestFingerprint, moduleFileDigestIssuesSync, verifyModuleSignature }
export type { SignedManifest }

/** What a bundle's or a provider's signed manifest is judged against: the publisher keys Studio trusts. */
export type ModuleTrustContext = {
  /** Accepted publisher key fingerprints (trusted-publishers.json). */
  trustedKeyFingerprints?: ReadonlySet<string>
}

/** What an installed extension is judged against: the person's approvals, and the trusted publisher keys. */
export type ExtensionStandingContext = ModuleTrustContext & {
  approvals: ReadonlyMap<string, ExtensionApprovalRecord>
}

export type ModuleTrustIssue = { path: string; message: string }

export type ModuleTrust = {
  status: ModuleTrustStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  fingerprint?: string
}

/** How an extension's files are signed: by a publisher key Studio trusts, another key, none, or not matching. */
export type ExtensionSignatureStatus = 'verified' | 'signed' | 'unsigned' | 'invalid'

/** Whether the person approved an extension as it is now. */
export type ExtensionApprovalStanding =
  /** Content only: nothing to approve. */
  | { state: 'not-needed' }
  | { state: 'approved'; fingerprint: string }
  /** Waiting for the person; `growth` says what it asks beyond an earlier approval, empty for a first one. */
  | { state: 'pending'; fingerprint: string; growth: string[]; reapproval: boolean }
  /** Its files cannot all be digested (a symbolic link put there since), so there is nothing to approve. */
  | { state: 'unavailable' }

/** An installed extension's standing, decided from the bytes on disk now. */
export type ExtensionStanding = {
  signature: ExtensionSignatureStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  signer?: string
  /** The files do not match the digests extension.sig signs. */
  tampered?: boolean
  /** Why its files are not vouched for, when that is what held it back. */
  issues?: ModuleTrustIssue[]
  approval: ExtensionApprovalStanding
  /** The content identity of its folder, when every file could be digested. */
  contentDigest?: string
  /**
   * When it may run: the digests its files were checked against. The loader
   * and the window-code server hold the files to these again before using them.
   */
  verifiedFiles?: ModuleFileDigests
}

/** Whether an extension may be drawn and run: approved (or content only) and not broken. */
export function isExtensionRunnable(standing: ExtensionStanding): boolean {
  return (
    standing.signature !== 'invalid' &&
    standing.verifiedFiles !== undefined &&
    (standing.approval.state === 'approved' || standing.approval.state === 'not-needed')
  )
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
 * An installed extension's standing, decided from the bytes on disk now.
 *
 * - Its signature: with extension.sig, a bad signature, or files that do not
 *   match the digests it signs, is `invalid` whoever signed it, and it never
 *   runs. A good one by a trusted publisher key is `verified`; by any other
 *   key, `signed`. Without, `unsigned`. A signature never approves anything.
 * - Its approval: content only needs none; anything else is approved when the
 *   person's approval names exactly its fingerprint now.
 */
export function classifyExtension(
  root: string,
  key: string,
  manifest: Pick<
    ExtensionManifest,
    'permissions' | 'tier' | 'main' | 'background' | 'contributes' | 'icon' | 'cover' | 'screenshots'
  >,
  ctx: ExtensionStandingContext,
): ExtensionStanding {
  const scan = computeModuleFileDigestsSync(root)
  const contentDigest = scan.ok ? extensionContentFingerprint(scan.files) : undefined
  const sigPath = join(root, EXTENSION_SIGNATURE_FILENAME)
  let signature: ExtensionSignatureStatus = 'unsigned'
  let signer: string | undefined
  if (existsSync(sigPath)) {
    const invalid = (issues: ModuleTrustIssue[], extra: Partial<ExtensionStanding> = {}): ExtensionStanding => ({
      signature: 'invalid',
      issues,
      approval: { state: 'unavailable' },
      ...extra,
    })
    let source: string
    try {
      source = readFileSync(sigPath, 'utf8')
    } catch {
      return invalid([{ path: EXTENSION_SIGNATURE_FILENAME, message: 'could not be read.' }])
    }
    const parsed = parseExtensionSignature(source)
    if (!parsed.ok) return invalid([{ path: EXTENSION_SIGNATURE_FILENAME, message: parsed.message }])
    const { valid, fingerprint } = verifyExtensionSignature(parsed.signature)
    if (!valid) return invalid([], fingerprint ? { signer: fingerprint } : {})
    const issues = [...(scan.ok ? [] : scan.issues), ...compareModuleFileDigests(parsed.signature.files, scan.files)]
    if (issues.length > 0) return invalid(issues, { tampered: true, ...(fingerprint ? { signer: fingerprint } : {}) })
    signer = fingerprint
    signature = fingerprint !== undefined && ctx.trustedKeyFingerprints?.has(fingerprint) ? 'verified' : 'signed'
  }
  const signed = signer !== undefined ? { signer } : {}
  if (!scan.ok) return { signature, ...signed, issues: scan.issues, approval: { state: 'unavailable' } }
  const access = extensionAccess(manifest, scan.files)
  const content = { contentDigest: contentDigest!, verifiedFiles: scan.files }
  if (!extensionNeedsApproval(manifest)) return { signature, ...signed, approval: { state: 'not-needed' }, ...content }
  const fingerprint = extensionApprovalFingerprint(access, contentDigest!)
  const record = ctx.approvals.get(key)
  if (record?.fingerprint === fingerprint)
    return { signature, ...signed, approval: { state: 'approved', fingerprint }, ...content }
  return {
    signature,
    ...signed,
    approval: {
      state: 'pending',
      fingerprint,
      growth: record ? accessGrowth(record.access, access) : [],
      reapproval: record !== undefined,
    },
    ...content,
  }
}

// Trust for a manifest alone — a plugin bundle's plugin.json or a provider
// manifest, whose bytes are covered by per-component digests checked
// separately. Never use it for an extension on disk: it does not look at the
// extension's code (classifyExtensionTrust does).
export function classifySignedManifestTrust(manifest: SignedManifest, ctx: ModuleTrustContext): ModuleTrust {
  if (!manifest.signature) return { status: 'unsigned' }
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) return { status: 'invalid', fingerprint }
  const keyAccepted = fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
  return keyAccepted ? { status: 'trusted', fingerprint } : { status: 'signed', fingerprint }
}

// Whether a bundle manifest carries a valid signature by a trusted publisher
// key: a statement about the manifest only.
export function isSignedByTrustedPublisher(manifest: SignedManifest, ctx: ModuleTrustContext): boolean {
  if (!manifest.signature) return false
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  return valid && fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
}

// Only a bundle or provider manifest signed by a trusted key is eligible.
export function isLoadEligible(trust: ModuleTrustStatus): boolean {
  return trust === 'trusted'
}
