// What an extension's frame calls are held to, read as things stand now, and
// pinned to the document the frame was drawn from.
//
// - As things stand now: the permissions of the extension's approval, while
//   it is installed, approved and switched on, not what the server loaded
//   when it started. An extension installed and approved during the session
//   is served at once; one switched off, uninstalled or revoked is refused at
//   the next call. An uninstall forgets the approval (extension-approvals.ts),
//   so an approval on record means the extension is installed. Only `ui` and
//   `worker` extensions have surfaces.
// - Pinned: when the server builds a frame's document (`extension.frame`) it
//   records what the approval held then, under the document's hash, and each
//   call names the document it came from. A call is held to the intersection
//   of the two. When the approval now holds more than the document was built
//   under (an update asked for more, and was approved while the frame stayed
//   open), the frame is `outdated`: its calls are refused, and the client
//   draws the surface again from the extension as it is now. A document this
//   server did not build, or no longer remembers, is outdated too.

import { readModuleOverridesSync } from '../module-host/enablement-store'
import type { ExtensionApprovalRecord } from './extension-approvals'

/** What a frame's calls are held to: null when the extension is not served; `outdated` to draw it again. */
export type ExtensionFrameGrant = { grant: readonly string[]; outdated: boolean } | null

const MAX_PINS = 1024
type Pin = { moduleId: string; permissions: readonly string[] }
const pins = new Map<string, Pin>()

/** Record what an extension's approval held when the document `hash` was built for it. */
export function pinExtensionFrame(hash: string, moduleId: string, permissions: readonly string[]): void {
  pins.delete(hash)
  pins.set(hash, { moduleId, permissions: [...permissions] })
  while (pins.size > MAX_PINS) pins.delete(pins.keys().next().value!)
}

export function createExtensionFrameGrant(options: {
  /** The approvals as they stand now (`createExtensionApprovalReader`). */
  approvals: () => ReadonlyMap<string, ExtensionApprovalRecord>
  dataDir: string
}): (moduleId: string, frame: string) => ExtensionFrameGrant {
  return (moduleId, frame) => {
    const record = options.approvals().get(moduleId)
    if (!record || (record.access.tier !== 'ui' && record.access.tier !== 'worker')) return null
    let switchedOff = false
    try {
      switchedOff = readModuleOverridesSync(options.dataDir)[moduleId] === false
    } catch {
      // Unreadable switches: the extension's own default, which is on.
    }
    if (switchedOff) return null
    const now = record.access.permissions
    const pin = pins.get(frame)
    if (!pin || pin.moduleId !== moduleId) return { grant: [], outdated: true }
    return {
      grant: now.filter((permission) => pin.permissions.includes(permission)),
      outdated: now.some((permission) => !pin.permissions.includes(permission)),
    }
  }
}
