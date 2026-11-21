import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

import type {
  ExtensionContributionsResult,
  StudioExtensionSurfacePoint,
  ThirdPartyRendererEntryView,
} from '../../../packages/studio-protocol/src/public'
import { EXTENSION_SURFACE_POINTS } from '../../shared/modules/third-party-manifest'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isExtensionRunnable } from './module-signature'
import type { InstalledModule } from './user-module-registry'

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
    // never vouched for, whatever is on disk under its name now.
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
    result.extensions.push({ id: installed.key, manifest: installed.manifest, extension: installed.extension })
  }
  return result
}

/** One surface's entry, read now and checked against the bytes it was verified with. */
export async function readExtensionSurfaceEntry(
  installed: InstalledModule,
  point: StudioExtensionSurfacePoint,
  id: string,
): Promise<{ ok: true; entryPath: string; code: string } | { ok: false; message: string }> {
  const contribution = installed.extension.contributes[point].find((surface) => surface.id === id)
  if (!contribution) return { ok: false, message: `Extension "${installed.key}" has no ${point} "${id}".` }
  const resolution = resolveRendererEntries(installed)
  if (!resolution.servable)
    return { ok: false, message: resolution.view.message ?? `Extension "${installed.key}" draws nothing now.` }
  const entry = resolution.entries.find((candidate) => candidate.path === contribution.entry)
  if (!entry) return { ok: false, message: READ_FAILURE_MESSAGE }
  try {
    // The bytes drawn are the bytes hashed: read once, checked, then used.
    const bytes = await readFile(entry.absolute)
    if (createHash('sha256').update(bytes).digest('hex') !== entry.expectedSha256)
      return { ok: false, message: CHANGED_MESSAGE }
    return { ok: true, entryPath: entry.path, code: bytes.toString('utf8') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: sanitizeEntryMessage(message, READ_FAILURE_MESSAGE) }
  }
}
