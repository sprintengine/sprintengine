import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

import type { ThirdPartyRendererEntriesResult, ThirdPartyRendererEntryView } from '../../shared/modules/manifest'
import { EXTENSION_SURFACE_POINTS } from '../../shared/modules/third-party-manifest'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isExtensionRunnable } from './module-signature'
import type { InstalledModule } from './user-module-registry'

// Serves approved extensions' window half: the `entry` bundle of each panel,
// door and settings section, beside the manifest whose commands, menus and
// top bar items the window registers (an extension with no window code is
// served with no entries, for those). Same approval gate as the worker: only
// an approved extension's entries, resolving inside its folder and matching the digests
// it was verified with, are served. The code travels over the Studio protocol
// (`extension.rendererEntries`; the window imports each bundle as a blob
// module), so a window loads the extensions of the Studio it is connected to,
// and the extension's folder is never exposed as file:// or a custom protocol.

const READ_FAILURE_MESSAGE = 'A window entry could not be read.'
const CHANGED_MESSAGE = 'A window entry changed after the extension was verified, so it was not served.'

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
      view: { availability: 'blocked', message: 'Its window code is held back until you approve the extension.' },
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
      return { servable: false, view: { availability: 'error', message: `The window entry ${path} is missing.` } }
    }
    // Runnable means the files were verified; an entry outside that set was
    // never vouched for, whatever is on disk under its name now.
    const expectedSha256 = installed.standing.verifiedFiles?.[path]
    if (expectedSha256 === undefined) {
      return {
        servable: false,
        view: { availability: 'error', message: `The window entry ${path} is not among the verified files.` },
      }
    }
    entries.push({ path, absolute, expectedSha256 })
  }
  return { servable: true, entries }
}

export function rendererEntryView(installed: InstalledModule): ThirdPartyRendererEntryView {
  const resolution = resolveRendererEntries(installed)
  if (!resolution.servable) return resolution.view
  return resolution.entries.length > 0 ? { availability: 'available' } : { availability: 'none' }
}

export async function collectThirdPartyRendererEntries(
  modules: readonly InstalledModule[],
  assetOrigin?: (moduleId: string) => string,
): Promise<ThirdPartyRendererEntriesResult> {
  const result: ThirdPartyRendererEntriesResult = { entries: [], failures: {} }
  for (const installed of modules) {
    const resolution = resolveRendererEntries(installed)
    if (!resolution.servable) {
      // Extensions waiting for approval are reported through their launch statuses;
      // only a declared-but-broken entry is a serving failure.
      if (resolution.view.availability === 'error' && resolution.view.message) {
        result.failures[installed.key] = resolution.view.message
      }
      continue
    }
    try {
      const entries: Record<string, string> = {}
      let changed = false
      for (const entry of resolution.entries) {
        // The bytes served are the bytes hashed: read once, checked against
        // the digest the extension was verified with, and only then sent.
        const bytes = await readFile(entry.absolute)
        if (createHash('sha256').update(bytes).digest('hex') !== entry.expectedSha256) {
          changed = true
          break
        }
        entries[entry.path] = bytes.toString('utf8')
      }
      if (changed) {
        result.failures[installed.key] = CHANGED_MESSAGE
        continue
      }
      result.entries.push({
        id: installed.key,
        manifest: installed.manifest,
        extension: installed.extension,
        entries,
        ...(assetOrigin ? { assetOrigin: assetOrigin(installed.key) } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failures[installed.key] = sanitizeEntryMessage(message, READ_FAILURE_MESSAGE)
    }
  }
  return result
}
