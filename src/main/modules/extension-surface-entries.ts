import { createHash } from 'crypto'
import { existsSync, lstatSync, readFileSync } from 'fs'

import {
  buildSurfaceModules,
  formatSourceProblem,
  type SourceProblem,
  type SurfaceModule,
} from '../../../packages/extension-sdk/src/source-modules'
import { isDevelopmentSkippedPath } from '../../../packages/extension-sdk/src/module-files'

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
      // folders), an installed one's are what was approved.
      const expected = verified[path]
      if (expected !== undefined || development) {
        const absolute = resolveContainedEntry(installed.moduleRoot, path, 'entry')
        const info = lstatSync(absolute)
        if (info.isFile() && (expected !== undefined || !isDevelopmentSkippedPath(path))) {
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
  const graph = buildSurfaceModules(contribution.entry, read)
  if (changed) return { ok: false, message: CHANGED_MESSAGE }
  if (!graph.ok)
    return {
      ok: false,
      message: sanitizeEntryMessage(formatSourceProblem(graph.problem), READ_FAILURE_MESSAGE),
      problem: graph.problem,
    }
  return { ok: true, entryPath: contribution.entry, modules: graph.modules, token: graph.token }
}
