// The module registry as the user sees it, reported by a window to its Studio
// (`module.reportRegistry`).
//
// The renderer owns the module universe: it registers every bundled renderer
// module (already narrowed to the build channel by `activeForChannel`), loads
// the trusted third-party ones, and holds the enablement overrides that decide
// what actually resolves. Main sees only its own half — the main-process
// modules plus the installed third-party folders — so anything that has to
// answer "what modules does this app have, and is one of them on?" must read
// the renderer's answer, not re-derive a second one.
//
// The window reports it on boot and on every change, the Studio keeps the last
// report in memory, and a consumer that has not received one yet says so rather than inventing an empty registry. Nothing here is
// persisted — it is a projection of live renderer state, valid only for the
// running app session.
//
// Consumer today: the Studio's `module.*` agent tools (src/main/automation).

import type {
  CapabilityManifest,
  ModuleContributedSurfaces,
  ModuleRegistryEntry,
  ModuleRegistrySnapshot,
  ModuleAbsence,
} from '../../../packages/studio-protocol/src/public'
import { isRecord } from '../records'

export type {
  ModuleAbsence,
  ModuleBuildChannel,
  ModuleContributedSurfaces,
  ModuleRegistryEntry,
  ModuleRegistrySnapshot,
  ModuleRegistrySnapshotWriteResult,
} from '../../../packages/studio-protocol/src/public'

export const EMPTY_MODULE_SURFACES: ModuleContributedSurfaces = {
  workspaceTypes: [],
  globalSurfaces: [],
  modalSurfaces: [],
  sidebarNavEntries: [],
  settingsSections: [],
  commands: [],
  topBarItems: [],
  backlogItemActions: [],
}

// The upper bound `new Date(ms).toISOString()` accepts (ECMAScript time range).
const MAX_TIMESTAMP_MS = 8.64e15

/**
 * Validate a pushed snapshot at the main-process boundary. The sender is our own
 * renderer, but an IPC payload is still input: a malformed push must be refused
 * outright rather than cached as a half-registry that consumers would read as
 * fact. Returns null when the value is not a usable snapshot.
 */
export function normalizeModuleRegistrySnapshot(value: unknown): ModuleRegistrySnapshot | null {
  if (!isRecord(value)) return null
  const { capturedAt, channel, modules } = value
  // Bounded, not merely finite: a consumer formats this as a date, and
  // `new Date(1e21).toISOString()` throws rather than returning nonsense.
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  if (capturedAt <= 0 || capturedAt > MAX_TIMESTAMP_MS) return null
  if (channel !== 'development' && channel !== 'production') return null
  if (!Array.isArray(modules)) return null
  const normalized: ModuleRegistryEntry[] = []
  for (const entry of modules) {
    const module = normalizeEntry(entry)
    if (!module) return null
    normalized.push(module)
  }
  return { capturedAt, channel, modules: normalized }
}

function normalizeEntry(value: unknown): ModuleRegistryEntry | null {
  if (!isRecord(value)) return null
  const { id, manifest, source, enabled, absence, surfaces } = value
  if (typeof id !== 'string' || id.trim().length === 0) return null
  if (!isRecord(manifest) || typeof manifest.id !== 'string') return null
  if (source !== 'bundled' && source !== 'third-party') return null
  if (typeof enabled !== 'boolean') return null
  return {
    id,
    manifest: manifest as unknown as CapabilityManifest,
    source,
    enabled,
    absence: normalizeAbsence(absence),
    surfaces: normalizeSurfaces(surfaces),
  }
}

function normalizeAbsence(value: unknown): ModuleAbsence | null {
  if (!isRecord(value)) return null
  const { reason, message } = value
  if (typeof reason !== 'string' || reason.length === 0) return null
  return { reason: reason as ModuleAbsence['reason'], message: typeof message === 'string' ? message : '' }
}

function normalizeSurfaces(value: unknown): ModuleContributedSurfaces {
  if (!isRecord(value)) return { ...EMPTY_MODULE_SURFACES }
  const read = (key: keyof ModuleContributedSurfaces): string[] => {
    const list = value[key]
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  }
  return {
    workspaceTypes: read('workspaceTypes'),
    globalSurfaces: read('globalSurfaces'),
    modalSurfaces: read('modalSurfaces'),
    sidebarNavEntries: read('sidebarNavEntries'),
    settingsSections: read('settingsSections'),
    commands: read('commands'),
    topBarItems: read('topBarItems'),
    backlogItemActions: read('backlogItemActions'),
  }
}
