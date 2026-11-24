// The surfaces approved extensions declare (panels, doors, settings
// sections, custom editors), each drawn in a sandboxed frame (ExtensionFrame) from a document
// the Studio builds.
//
// The surfaces are registered from the extensions' extension.json
// (extension-contributions.tsx); the pane, the door shell and Settings read
// them from here.

import type { ExtensionSurfaceContribution, ExtensionSurfacePoint } from '../../../shared/modules/third-party-manifest'
import type { InternalRendererHost } from './renderer-host'

export type LoadedExtensionSurface = {
  /** The extension's install key. */
  key: string
  point: ExtensionSurfacePoint
  contribution: ExtensionSurfaceContribution
  /** The extension's scoped host, for what a frame's admitted client calls do in this window. */
  host: InternalRendererHost
  /** Whether it may be offered now: the extension is switched on and still served. Absent: always. */
  live?: () => boolean
  /** The extension's name and the permissions it holds, as its extension.json says them. */
  extension?: { name: string; permissions: readonly string[] }
}

const surfaces = new Map<string, LoadedExtensionSurface>()

// Who draws a surface hears when the set changes: an extension that is
// uninstalled or no longer trusted takes its surfaces with it, and an open
// one unmounts rather than keep running its code.
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

/** Hear the set of surfaces change; returns the unsubscriber. */
export function subscribeExtensionSurfaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A number that moves whenever the set of surfaces changes. */
export function extensionSurfacesVersion(): number {
  return version
}

function surfaceKey(key: string, point: ExtensionSurfacePoint, id: string): string {
  return `${key}\u0000${point}\u0000${id}`
}

export function registerExtensionSurface(surface: LoadedExtensionSurface): void {
  surfaces.set(surfaceKey(surface.key, surface.point, surface.contribution.id), surface)
  changed()
}

/** Take every surface of an extension out, and hand them back for a later restore. */
export function retireExtensionSurfaces(key: string): LoadedExtensionSurface[] {
  const retired = [...surfaces.entries()].filter(([, surface]) => surface.key === key)
  for (const [id] of retired) surfaces.delete(id)
  if (retired.length > 0) changed()
  return retired.map(([, surface]) => surface)
}

export function getExtensionSurface(
  key: string,
  point: ExtensionSurfacePoint,
  id: string,
): LoadedExtensionSurface | undefined {
  return surfaces.get(surfaceKey(key, point, id))
}

/** Every surface of one point, in a stable order: extension, then contribution. */
export function getExtensionSurfacesOf(point: ExtensionSurfacePoint): LoadedExtensionSurface[] {
  return [...surfaces.values()]
    .filter((surface) => surface.point === point && (surface.live?.() ?? true))
    .sort((a, b) => a.key.localeCompare(b.key) || a.contribution.id.localeCompare(b.contribution.id))
}

/** The panels of every extension that is on, in a stable order: extension, then panel. */
export function getExtensionPanels(moduleEnabled?: (moduleId: string) => boolean): LoadedExtensionSurface[] {
  return [...surfaces.values()]
    .filter((surface) => surface.point === 'panels' && (!moduleEnabled || moduleEnabled(surface.key)))
    .sort((a, b) => a.key.localeCompare(b.key) || a.contribution.id.localeCompare(b.contribution.id))
}

// ── Readiness ───────────────────────────────────────────────────────────────
// How long a surface takes from being opened (its frame's host mounting) to
// its `studio.ready()`, and to its frame's first contentful paint, both read
// on this window's clock (`performance.timeOrigin`-based epoch ms).

export type ExtensionReadiness = {
  key: string
  point: ExtensionSurfacePoint
  id: string
  /** Opened to `studio.ready()`. */
  ms: number
  /** Opened to the frame's first contentful paint, when the frame reported one first. */
  paintMs?: number
}

const READINESS_KEPT = 50
const readiness: ExtensionReadiness[] = []

/** The latest readiness measurements, newest last. */
export function readExtensionReadiness(): readonly ExtensionReadiness[] {
  return readiness
}

/** Record one surface's readiness, and mark it for the window's performance timeline. */
export function recordReadiness(entry: ExtensionReadiness): void {
  readiness.push(entry)
  if (readiness.length > READINESS_KEPT) readiness.shift()
  try {
    performance.measure(`extension-ready ${entry.key} ${entry.point}/${entry.id}`, {
      start: performance.now() - entry.ms,
      duration: entry.ms,
    })
  } catch {
    // A runtime without User Timing keeps the in-memory record alone.
  }
}
