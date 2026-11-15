// The user-global design-system library (main-process registry ↔ preload ↔
// renderer).
//
// **The library is a list of references, not a store of copies.** Owner ruling
// 2026-07-30: a design system lives in a Git repo the user clones, versions and
// pulls themselves. We point at the folder and read it live. Nothing here copies
// a bundle anywhere, and nothing writes inside a registered folder.
//
// It used to be a copy store, written by an app-local release pipeline that item
// 2001 deleted. With nothing writing copies, keeping the copy store would have
// left a library that could only ever shrink. Copies from that era are ADOPTED as
// registered paths pointing at themselves — never moved, never deleted.
//
// Bundle format contract: resources/design-system/templates/USAGE.md.

import type {
  DesignSystemLibraryEntry,
  DesignSystemManifest,
  DesignSystemSourceState,
} from '../../../packages/studio-protocol/src/public'
export type {
  DesignSystemLibraryEntry,
  DesignSystemLibraryListResult,
  DesignSystemRegisterResult,
  DesignSystemSourceState,
} from '../../../packages/studio-protocol/src/public'
/** Registry schema version, so a future shape change has a migration point. */
export const DESIGN_SYSTEM_REGISTRY_SCHEMA_VERSION = 1

/** One folder the user has pointed at. */
export interface DesignSystemRegistration {
  /**
   * Stable id: an FNV-1a hash of the normalised absolute path.
   *
   * Keyed by PATH rather than by name@version because two cloned repos can
   * legitimately hold the same name and version — a collision the old
   * `<name>/<version>/` addressing could not express. A name clash is a display
   * concern, never an error.
   */
  id: string
  /** Absolute bundle directory. Deliberately outside our storage. */
  path: string
  /**
   * Name and version as last read from the manifest.
   *
   * DISPLAY CACHE ONLY — so a row can render before its read lands, and so a
   * folder that has gone missing still shows what it used to be. Never the
   * source of truth: both are re-read from the manifest on every open.
   */
  name: string | null
  version: string | null
  /** ISO timestamp the path was registered. */
  addedAt: string
}

export interface DesignSystemRegistryFile {
  schemaVersion: number
  entries: DesignSystemRegistration[]
  /**
   * Whether release-era copies under the old library root have been adopted.
   *
   * Recorded so adoption runs once: a user who deliberately forgets an adopted
   * copy must not have it reappear on the next read.
   */
  adoptedLegacyCopies?: boolean
}

export type DesignSystemLibraryReadResult =
  | { ok: true; entry: DesignSystemLibraryEntry; manifest: DesignSystemManifest }
  | { ok: false; message: string; sourceState: DesignSystemSourceState }

/**
 * FNV-1a over the normalised path — the same hashing the Backlog object ids use.
 *
 * Not cryptographic and does not need to be: it is a stable local key for a
 * string the user chose, and a collision would only ever merge two rows the user
 * can re-point.
 */
export function designSystemRegistrationId(absolutePath: string): string {
  const normalised = normaliseRegistryPath(absolutePath)
  let hash = 0x811c9dc5
  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * One spelling per folder: trailing separators dropped, and `\` folded to `/`.
 *
 * Case is NOT folded. macOS and Windows are usually case-insensitive and Linux
 * is not, and treating two genuinely different Linux folders as one entry would
 * silently lose a system — the wrong way to be wrong.
 */
export function normaliseRegistryPath(absolutePath: string): string {
  return absolutePath.replace(/\\/g, '/').replace(/\/+$/, '')
}
