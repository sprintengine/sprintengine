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
// - Runnable: approval and its switch are not enough. A kill, a folder whose
//   files no longer match (its signature, its approval's fingerprint), or one
//   gone or no longer valid, keeps the approval on record, so each call also
//   asks how the extension stands now (`standing`, the server's discovery):
//   runnable, its folder still there, and its version not on the kill list as
//   it is on disk now (read at every call, so a kill applies before the
//   discovery hears of it). A frame of an extension that stops being runnable
//   loses its pins: should it run again, its surfaces are drawn again first.
// - Its files now: discovery's standing is read once per change it hears of,
//   and a change deep in an installed folder can go unheard. So each call
//   also takes the folder's content digest (a match is trusted for two
//   seconds) and compares it with the one discovery judged. When they differ,
//   discovery reads the folder again (`refresh`) and the call is judged by
//   that reading, so an extension whose files stopped matching its approval
//   is refused at once.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { findKilled } from '../../../packages/extension-sdk/src/catalogue'
import { readKillListCacheSync } from '../../server/extensions/catalogue/catalogue-files'
import { extensionContentSync } from './module-signature'
import { EXTENSION_MANIFEST_FILENAME } from '../../shared/modules/third-party-manifest'
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

/** Forget every document built for `moduleId`: its open frames are drawn again before they are served. */
export function dropExtensionFramePins(moduleId: string): void {
  for (const [hash, pin] of pins) if (pin.moduleId === moduleId) pins.delete(hash)
}

/** How an installed extension stands now, as the server's discovery reads it. */
export type ExtensionFrameStanding = {
  /** Not killed, its signature and files good, approved as it is now (`isExtensionRunnable`). */
  runnable: boolean
  version: string
  /** The folder it runs from. */
  moduleRoot: string
  /** The content digest of its folder when discovery judged it; undefined when it could not be read. */
  contentDigest: string | undefined
  /** A development folder: its files are walked as a development folder's are. */
  development: boolean
}

/** How long a folder's matching content digest is trusted before it is taken again. */
const FOLDER_DIGEST_TTL_MS = 2_000
const matchedAt = new Map<string, { digest: string; at: number }>()

/** The content digest of `standing`'s folder now, or null when it cannot be read; a match is trusted briefly. */
function digestNow(standing: ExtensionFrameStanding, now = Date.now()): string | null {
  const cached = matchedAt.get(standing.moduleRoot)
  if (cached && cached.digest === standing.contentDigest && now - cached.at < FOLDER_DIGEST_TTL_MS) return cached.digest
  const content = extensionContentSync(standing.moduleRoot, { development: standing.development })
  const digest = content.ok ? content.fingerprint : null
  if (digest === null) matchedAt.delete(standing.moduleRoot)
  else matchedAt.set(standing.moduleRoot, { digest, at: now })
  return digest
}

export function createExtensionFrameGrant(options: {
  /** The approvals as they stand now (`createExtensionApprovalReader`). */
  approvals: () => ReadonlyMap<string, ExtensionApprovalRecord>
  dataDir: string
  /** How the extension stands now, as discovery read it; undefined when no folder holds it. */
  standing: (moduleId: string) => ExtensionFrameStanding | undefined
  /** Discovery's reading of the extension is behind its folder: read it again. */
  refresh: (moduleId: string) => void
}): (moduleId: string, frame: string) => ExtensionFrameGrant {
  const runnableNow = (moduleId: string): boolean => {
    let standing = options.standing(moduleId)
    if (!standing?.runnable) return false
    if (!existsSync(join(standing.moduleRoot, EXTENSION_MANIFEST_FILENAME))) return false
    let digest = digestNow(standing)
    if (digest !== standing.contentDigest) {
      // Its files changed since discovery judged them: judged again from the folder as it is.
      options.refresh(moduleId)
      standing = options.standing(moduleId)
      if (!standing?.runnable) return false
      digest = digestNow(standing)
      if (digest === null || digest !== standing.contentDigest) return false
    }
    return findKilled(readKillListCacheSync(options.dataDir), moduleId, standing.version) === null
  }
  return (moduleId, frame) => {
    const record = options.approvals().get(moduleId)
    if (!record || (record.access.tier !== 'ui' && record.access.tier !== 'worker')) return null
    if (!runnableNow(moduleId)) {
      dropExtensionFramePins(moduleId)
      return null
    }
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
