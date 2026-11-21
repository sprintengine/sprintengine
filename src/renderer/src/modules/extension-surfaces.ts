// The window half of an installed extension: the surfaces its extension.json
// declares (panels, doors, settings sections), each drawn by the `mount` its
// `entry` exports, and the `studio` object that mount is handed.
//
// The surfaces are registered by the loader (third-party-loader.ts) once an
// extension's entries are evaluated; the pane, the door shell and Settings
// read them from here, and `ExtensionSurfaceMount` runs the mount in a root
// the shell owns.

import type {
  ExtensionMount,
  ExtensionMountStudio,
  ExtensionSurface,
  RendererHost as SdkRendererHost,
} from '../../../../packages/extension-sdk/src/index'
import type { ExtensionSurfaceContribution, ExtensionSurfacePoint } from '../../../shared/modules/third-party-manifest'
import { extensionSurfaceId } from '../../../shared/modules/extension-ids'
import type { InternalRendererHost } from './renderer-host'

export type LoadedExtensionSurface = {
  /** The extension's install key. */
  key: string
  point: ExtensionSurfacePoint
  contribution: ExtensionSurfaceContribution
  mount: ExtensionMount
  host: InternalRendererHost
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

/** The panels of every extension that is on, in a stable order: extension, then panel. */
export function getExtensionPanels(moduleEnabled?: (moduleId: string) => boolean): LoadedExtensionSurface[] {
  return [...surfaces.values()]
    .filter((surface) => surface.point === 'panels' && (!moduleEnabled || moduleEnabled(surface.key)))
    .sort((a, b) => a.key.localeCompare(b.key) || a.contribution.id.localeCompare(b.contribution.id))
}

// What a surface's `mount` may call: exactly the SDK's RendererHost. The
// window's own host carries the shell's register calls too; they are not
// handed to extension code.
const STUDIO_MEMBERS = [
  'moduleId',
  'supports',
  'getAssetUrl',
  'openGlobalSurface',
  'listBacklogItems',
  'watchBacklogItems',
  'getBacklogLocation',
  'createBacklogItem',
  'updateBacklogStatus',
  'updateBacklogTriage',
  'addBacklogLink',
  'updateBacklogModuleMetadata',
  'queryUsage',
  'getWorkspace',
  'listWorkspaces',
  'getWorkspaceGitInfo',
  'watchWorkspaces',
  'watchColorScheme',
  'getWorkspaceModuleState',
  'setWorkspaceModuleState',
  'getModuleAppState',
  'setModuleAppState',
  'watchModuleAppState',
  'subscribe',
  'getWorkingRoot',
  'watchWorkspaceFile',
  'focusTab',
  'openChat',
  'listChatRuntimes',
  'toast',
  'getActiveWorkspaceId',
  'watchActiveWorkspace',
  'openExternal',
  'methods',
] as const satisfies readonly (keyof SdkRendererHost)[]

// Every member of the SDK's RendererHost is listed above: a member added there
// and not here fails this line.
const _everyMember: Exclude<keyof SdkRendererHost, (typeof STUDIO_MEMBERS)[number]> extends never ? true : false = true
void _everyMember

// ── Readiness ───────────────────────────────────────────────────────────────
// How long a surface takes from being opened to its `studio.ready()`: the
// in-process baseline a later move into isolated frames is measured against.

export type ExtensionReadiness = { key: string; point: ExtensionSurfacePoint; id: string; ms: number }

const READINESS_KEPT = 50
const readiness: ExtensionReadiness[] = []

/** The latest readiness measurements, newest last. */
export function readExtensionReadiness(): readonly ExtensionReadiness[] {
  return readiness
}

function recordReadiness(entry: ExtensionReadiness): void {
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

/**
 * The `studio` one surface's mount is handed: the SDK's RendererHost picked
 * from the extension's scoped host, its doors named by their manifest ids,
 * and this surface with its `ready()`.
 */
export function extensionMountStudio(
  loaded: LoadedExtensionSurface,
  surface: ExtensionSurface,
  openedAt: number,
): ExtensionMountStudio {
  const host = loaded.host as unknown as SdkRendererHost
  const picked: Record<string, unknown> = {}
  for (const member of STUDIO_MEMBERS) {
    const value = host[member]
    picked[member] = typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(host) : value
  }
  let readied = false
  return Object.freeze({
    ...(picked as SdkRendererHost),
    openGlobalSurface: (id: string) =>
      typeof id === 'string' && host.openGlobalSurface(extensionSurfaceId(loaded.key, id)),
    surface: Object.freeze({ ...surface }),
    ready() {
      if (readied) return
      readied = true
      recordReadiness({ key: loaded.key, point: surface.point, id: surface.id, ms: performance.now() - openedAt })
    },
  })
}
