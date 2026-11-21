// What an extension's frame calls are held to, read as things stand now: the
// permissions of its approval, while it is installed, approved and switched
// on. A frame is drawn from the extension as it is on disk when it opens
// (`extension.frame`), so its calls are judged the same way, not by what the
// server loaded when it started: an extension installed and approved during
// the session is served at once, and one switched off, uninstalled or
// revoked is refused at the next call.
//
// An uninstall forgets the approval (extension-approvals.ts), so an approval
// on record means the extension is installed. Only `ui` and `worker`
// extensions have surfaces.

import { readModuleOverridesSync } from '../module-host/enablement-store'
import type { ExtensionApprovalRecord } from './extension-approvals'

export function createExtensionFrameGrant(options: {
  /** The approvals as they stand now (`createExtensionApprovalReader`). */
  approvals: () => ReadonlyMap<string, ExtensionApprovalRecord>
  dataDir: string
}): (moduleId: string) => readonly string[] | null {
  return (moduleId) => {
    const record = options.approvals().get(moduleId)
    if (!record || (record.access.tier !== 'ui' && record.access.tier !== 'worker')) return null
    let switchedOff = false
    try {
      switchedOff = readModuleOverridesSync(options.dataDir)[moduleId] === false
    } catch {
      // Unreadable switches: the extension's own default, which is on.
    }
    return switchedOff ? null : record.access.permissions
  }
}
