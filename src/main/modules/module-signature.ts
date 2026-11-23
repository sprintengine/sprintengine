// What vouches for an installed extension.
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
  moduleFileDigestIssuesSync,
  parseExtensionSignature,
  verifyExtensionSignature,
  verifyModuleSignature,
} from '../../../packages/extension-sdk/src/signing'
import { compareModuleFileDigests } from '../../../packages/extension-sdk/src/manifest-validate'
import { EXTENSION_SIGNATURE_FILENAME } from '../../../packages/extension-sdk/src/extension-manifest'

import type { ModuleFileDigests } from '../../shared/modules/manifest'
import { findKilled, type KillList } from '../../../packages/extension-sdk/src/catalogue'
import type { ExtensionManifest } from '../../shared/modules/third-party-manifest'
import {
  accessGrowth,
  devFolderApprovalFingerprint,
  extensionAccess,
  extensionApprovalFingerprint,
  extensionNeedsApproval,
  type ExtensionApprovalRecord,
} from './extension-approvals'

export { moduleFileDigestIssuesSync, verifyModuleSignature }

/** What an installed extension is judged against: the person's approvals, and the trusted publisher keys. */
export type ExtensionStandingContext = {
  /** Accepted publisher key fingerprints (trusted-publishers.json). */
  trustedKeyFingerprints?: ReadonlySet<string>
  approvals: ReadonlyMap<string, ExtensionApprovalRecord>
  /** The development folders the owner registered here, by real path, in registration order. */
  devFolders?: readonly string[]
  /** Studio's data folder: no development folder may be inside it (or the extensions folder). */
  dataDir?: string
  /** The kill list as last read: a version on it never runs. */
  killList?: KillList | null
  /**
   * The keys Studio installed from a catalogue or a git URL, under their
   * repository owner: `official` for Studio's official catalogue, which alone
   * may install a reserved key. A folder install's key is `local` and needs none.
   */
  installedFrom?: ReadonlyMap<string, 'official' | 'other'>
}

export type ModuleTrustIssue = { path: string; message: string }

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
  /** The kill list holds this version: it never runs, and everything it added is retracted. */
  killed?: { reason: string; advisoryUrl?: string }
  /**
   * When it may run: the digests its files were checked against. The loader
   * and the window-code server hold the files to these again before using them.
   */
  verifiedFiles?: ModuleFileDigests
}

/** Whether an extension may be drawn and run: approved (or content only) and not broken. */
export function isExtensionRunnable(standing: ExtensionStanding): boolean {
  return (
    standing.killed === undefined &&
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
  manifest: Pick<ExtensionManifest, 'permissions' | 'tier' | 'main' | 'background' | 'contributes'> & {
    version?: string
  },
  ctx: ExtensionStandingContext,
): ExtensionStanding {
  const judged = classifyInstalled(root, key, manifest, ctx)
  const entry = manifest.version !== undefined ? findKilled(ctx.killList ?? null, key, manifest.version) : null
  if (!entry) return judged
  return {
    ...judged,
    killed: { reason: entry.reason, ...(entry.advisoryUrl ? { advisoryUrl: entry.advisoryUrl } : {}) },
  }
}

function classifyInstalled(
  root: string,
  key: string,
  manifest: Pick<ExtensionManifest, 'permissions' | 'tier' | 'main' | 'background' | 'contributes'>,
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
  // A development folder's approval never covers the installed extension under its key.
  const found = ctx.approvals.get(key)
  const record = found && found.devFolder === undefined ? found : undefined
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

/**
 * A development folder's standing, decided from the folder now. Its files are
 * digested as they are (node_modules, .git, dotted folders and links left
 * out) for the content identity a reload compares, but approval is not bound
 * to them: it holds while the folder asks for no more than the person
 * approved for this folder (`devFolderApprovalFingerprint`), and asks again
 * when it asks for more. Every folder asks once, even one that asks for
 * nothing: registering is something an agent may do, approving is the
 * person's. Its signature is not read: a working copy is not what anybody
 * signed.
 */
export function classifyDevelopmentExtension(
  folder: string,
  key: string,
  manifest: Pick<ExtensionManifest, 'permissions' | 'tier' | 'main' | 'background' | 'contributes'>,
  ctx: ExtensionStandingContext,
): ExtensionStanding {
  const scan = computeModuleFileDigestsSync(folder, { walk: 'development' })
  if (!scan.ok) return { signature: 'unsigned', issues: scan.issues, approval: { state: 'unavailable' } }
  const content = { contentDigest: extensionContentFingerprint(scan.files), verifiedFiles: scan.files }
  // Its local servers are bound to their command, arguments and environment,
  // not to the files they may run: those are the working copy.
  const access = extensionAccess(manifest, {})
  const fingerprint = devFolderApprovalFingerprint(access, folder)
  const found = ctx.approvals.get(key)
  const record = found?.devFolder === folder ? found : undefined
  if (record) {
    const growth = accessGrowth(record.access, access)
    if (growth.length === 0)
      return { signature: 'unsigned', approval: { state: 'approved', fingerprint: record.fingerprint }, ...content }
    return {
      signature: 'unsigned',
      approval: { state: 'pending', fingerprint, growth, reapproval: true },
      ...content,
    }
  }
  return {
    signature: 'unsigned',
    approval: { state: 'pending', fingerprint, growth: [], reapproval: false },
    ...content,
  }
}
