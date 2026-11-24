import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { computeModuleFileDigestsSync, extensionContentFingerprint } from '../../../packages/extension-sdk/src/signing'
import { EXTENSION_MANIFEST_FILENAME, parseExtensionManifest } from '../../shared/modules/third-party-manifest'
import { extensionAccess, extensionApprovalFingerprint, type ExtensionApprovalRecord } from './extension-approvals'
import type { ExtensionStandingContext } from './module-signature'

/** The approval the person would give an extension's folder as it is now. */
export function approvalOf(folder: string): ExtensionApprovalRecord {
  const parsed = parseExtensionManifest(readFileSync(join(folder, EXTENSION_MANIFEST_FILENAME), 'utf8'))
  if (!parsed.ok) throw new Error(`${folder}: extension.json is invalid`)
  const scan = computeModuleFileDigestsSync(folder)
  if (!scan.ok) throw new Error(`${folder}: its files cannot all be digested`)
  const access = extensionAccess(parsed.manifest, scan.files)
  return { fingerprint: extensionApprovalFingerprint(access, extensionContentFingerprint(scan.files)), access }
}

/** A standing context in which each named folder is approved as it is now, under its install key. */
export function approvedContext(
  folders: Record<string, string> = {},
): ExtensionStandingContext & { approvals: Map<string, ExtensionApprovalRecord> } {
  return {
    approvals: new Map(Object.entries(folders).map(([key, folder]) => [key, approvalOf(folder)])),
  }
}
