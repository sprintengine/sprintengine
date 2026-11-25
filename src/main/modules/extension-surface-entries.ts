import { createHash } from 'crypto'
import { existsSync, lstatSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  buildSurfaceModules,
  formatSourceProblem,
  type SourceProblem,
  type SurfaceModule,
} from '../../../packages/extension-sdk/src/source-modules'

import type {
  ExtensionContributionsResult,
  StudioExtensionSurfacePoint,
  ThirdPartyRendererEntryView,
} from '../../../packages/studio-protocol/src/public'
import { EXTENSION_SURFACE_POINTS } from '../../shared/modules/third-party-manifest'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isExtensionRunnable } from './module-signature'
import type { InstalledModule } from './user-module-registry'
import { COMPONENTS_RUNTIME_SOURCE } from '../../server/extensions/frames/components-runtime.generated'
import { isComponentImagePath } from '../../../packages/extension-sdk/src/components/catalog'

// What an approved extension adds to a client, and the code its surfaces are
// drawn from. Clients register its commands, menus, top bar items, panels,
// doors and settings sections from its extension.json alone
// (`extension.contributions`); a surface's `entry` is read only when a client
// opens it, into the frame document the server builds (`extension.frame`).
// Same approval gate as the worker: only an approved extension's entries,
// resolving inside its folder and matching the digests it was verified with,
// are ever read for a frame, and the extension's folder is never exposed to a
// client.

const READ_FAILURE_MESSAGE = 'A surface’s entry could not be read.'
const CHANGED_MESSAGE = 'A surface’s entry changed after the extension was verified, so it was not drawn.'

type EntryResolution = { path: string; absolute: string; expectedSha256: string }

type RendererEntriesResolution =
  { servable: true; entries: EntryResolution[] } | { servable: false; view: ThirdPartyRendererEntryView }

/** Every distinct `entry` its panels, doors and settings sections name. */
function declaredEntries(installed: InstalledModule): string[] {
  const entries = new Set<string>()
  for (const point of EXTENSION_SURFACE_POINTS) {
    for (const surface of installed.extension.contributes[point]) entries.add(surface.entry)
  }
  return [...entries].sort()
}

// Pure availability check used both by the launch view (Settings → Extensions)
// and by the serving path below, so what the UI reports and what actually
// loads can never disagree.
function resolveRendererEntries(installed: InstalledModule): RendererEntriesResolution {
  const declared = declaredEntries(installed)
  if (!isExtensionRunnable(installed.standing)) {
    if (declared.length === 0) return { servable: false, view: { availability: 'none' } }
    return {
      servable: false,
      view: { availability: 'blocked', message: 'Its surfaces are held back until you approve the extension.' },
    }
  }
  const entries: EntryResolution[] = []
  for (const path of declared) {
    let absolute: string
    try {
      absolute = resolveContainedEntry(installed.moduleRoot, path, 'entry')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        servable: false,
        view: { availability: 'error', message: sanitizeEntryMessage(message, READ_FAILURE_MESSAGE) },
      }
    }
    if (!existsSync(absolute)) {
      return { servable: false, view: { availability: 'error', message: `The surface entry ${path} is missing.` } }
    }
    // Runnable means the files were verified; an entry outside that set was
    // never vouched for, whatever is on disk under its name now. A
    // development folder's are its files as they were last read.
    const expectedSha256 = installed.standing.verifiedFiles?.[path]
    if (expectedSha256 === undefined) {
      return {
        servable: false,
        view: { availability: 'error', message: `The surface entry ${path} is not among the verified files.` },
      }
    }
    entries.push({ path, absolute, expectedSha256 })
  }
  return { servable: true, entries }
}

export function surfaceEntriesView(installed: InstalledModule): ThirdPartyRendererEntryView {
  const resolution = resolveRendererEntries(installed)
  if (!resolution.servable) return resolution.view
  return resolution.entries.length > 0 ? { availability: 'available' } : { availability: 'none' }
}

/** What each approved extension adds to a client; one whose surfaces cannot be drawn is a failure instead. */
export function collectExtensionContributions(modules: readonly InstalledModule[]): ExtensionContributionsResult {
  const result: ExtensionContributionsResult = { extensions: [], failures: {} }
  for (const installed of modules) {
    const resolution = resolveRendererEntries(installed)
    if (!resolution.servable) {
      // Extensions waiting for approval are reported through their launch statuses;
      // only a declared-but-broken entry is a failure.
      if (resolution.view.availability === 'error' && resolution.view.message) {
        result.failures[installed.key] = resolution.view.message
      }
      continue
    }
    result.extensions.push({
      id: installed.key,
      manifest: installed.manifest,
      extension: installed.extension,
      ...(installed.standing.contentDigest ? { revision: installed.standing.contentDigest } : {}),
      ...(installed.development !== undefined ? { development: true as const } : {}),
    })
  }
  return result
}

/** A surface's modules as its frame loads them, or why it cannot be drawn. */
export type SurfaceModulesAnswer =
  | { ok: true; entryPath: string; modules: SurfaceModule[]; token: string }
  /** `problem`: the author's code is at fault, at its file and line (a syntax error, a bad import). */
  | { ok: false; message: string; problem?: SourceProblem }

/**
 * One surface's entry and every module it imports, read now: an installed
 * extension's checked against the bytes it was verified with, a development
 * folder's as it is on disk (its approval is not bound to its code). Each
 * TypeScript or JSX file is transpiled as it is read (source-modules.ts).
 */
/** Whether any folder on `path`'s way down from `root` is a symbolic link. */
function throughLink(root: string, path: string): boolean {
  const segments = path.split('/')
  let at = root
  for (const segment of segments.slice(0, -1)) {
    at = join(at, segment)
    if (lstatSync(at).isSymbolicLink()) return true
  }
  return false
}

export async function readSurfaceModules(
  installed: InstalledModule,
  point: StudioExtensionSurfacePoint,
  id: string,
): Promise<SurfaceModulesAnswer> {
  const contribution = installed.extension.contributes[point].find((surface) => surface.id === id)
  if (!contribution) return { ok: false, message: `Extension "${installed.key}" has no ${point} "${id}".` }
  const resolution = resolveRendererEntries(installed)
  if (!resolution.servable)
    return { ok: false, message: resolution.view.message ?? `Extension "${installed.key}" draws nothing now.` }
  const verified = installed.standing.verifiedFiles ?? {}
  const development = installed.development !== undefined
  let changed = false
  const cache = new Map<string, string | null>()
  const read = (path: string): string | null => {
    if (cache.has(path)) return cache.get(path)!
    let text: string | null = null
    try {
      // Only a file among those it was read with: a development folder's
      // digests are taken over what it serves (no node_modules, no dotted
      // folders, nothing through a link), an installed one's are what was
      // approved. A development folder's file is read again now, and never
      // through a folder that became a link since.
      const expected = verified[path]
      if (expected !== undefined) {
        const absolute = resolveContainedEntry(installed.moduleRoot, path, 'entry')
        const info = lstatSync(absolute)
        if (info.isFile() && !(development && throughLink(installed.moduleRoot, path))) {
          const bytes = readFileSync(absolute)
          if (!development && createHash('sha256').update(bytes).digest('hex') !== expected) changed = true
          else text = bytes.toString('utf8')
        }
      }
    } catch {
      text = null
    }
    cache.set(path, text)
    return text
  }
  // A components panel compiles its JSX for Studio's components module, which is loaded with it.
  const graph = buildSurfaceModules(
    contribution.entry,
    read,
    point === 'panels' && contribution.ui === 'components'
      ? { jsx: 'components', componentsModule: COMPONENTS_RUNTIME_SOURCE }
      : {},
  )
  if (changed) return { ok: false, message: CHANGED_MESSAGE }
  if (!graph.ok)
    return {
      ok: false,
      message: sanitizeEntryMessage(formatSourceProblem(graph.problem), READ_FAILURE_MESSAGE),
      problem: graph.problem,
    }
  return { ok: true, entryPath: contribution.entry, modules: graph.modules, token: graph.token }
}

/** The largest image a components panel's `Image` shows. */
export const SURFACE_IMAGE_MAX_BYTES = 8 * 1024 * 1024

function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  return null
}

/**
 * One of an extension's own images, for a components panel's `Image` and its
 * Markdown: a PNG, JPEG or WebP file among those it was verified with (an
 * installed extension's bytes still matching), inside its folder, at most
 * 8 MiB, its type read from its header. Null for anything else.
 */
export function readSurfaceImage(
  installed: InstalledModule | undefined,
  path: string,
): { mime: string; data: string } | null {
  if (!installed || !isExtensionRunnable(installed.standing) || !isComponentImagePath(path)) return null
  const expected = installed.standing.verifiedFiles?.[path]
  if (expected === undefined) return null
  const development = installed.development !== undefined
  try {
    const absolute = resolveContainedEntry(installed.moduleRoot, path, 'entry')
    const info = lstatSync(absolute)
    if (!info.isFile() || info.size > SURFACE_IMAGE_MAX_BYTES) return null
    if (development && throughLink(installed.moduleRoot, path)) return null
    const bytes = readFileSync(absolute)
    if (!development && createHash('sha256').update(bytes).digest('hex') !== expected) return null
    const mime = imageType(bytes)
    return mime ? { mime, data: bytes.toString('base64') } : null
  } catch {
    return null
  }
}
