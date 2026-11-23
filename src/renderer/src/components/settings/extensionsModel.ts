// Settings → Extensions, the derivations. DOM-free so every rule the page
// draws by — which state word a row wears, when the restart banner shows,
// where Update is offered, what a filter keeps — is asserted without
// rendering anything.

import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import { capabilityAccess, partitionCapabilityAccess } from '../../../../shared/modules/permissions'
import type { ExtensionContributionsState as ThirdPartyRendererLoadState } from '../../modules/extension-contributions'
import type { AccessItem } from '../ui'
import { copy } from '../../../../shared/copy'

// ── State ────────────────────────────────────────────────────────────────

/** Whether the person approved it as it is (or it only carries content, which needs no approval). */
export function isApproved(module: Pick<ThirdPartyModuleView, 'approval'>): boolean {
  return module.approval.state === 'approved' || module.approval.state === 'not-needed'
}

/**
 * What an approved module is doing, in the words its row says:
 * - `running` — its code is loaded in this session (Running);
 * - `on` — on, with no code of its own to run (On);
 * - `pending` — on, but its main entry waits on the next launch (Starts after restart);
 * - `off` — off (Off);
 * - `waiting` — on, but its worker waits for a place: too many already run (Waiting to start), with why as a notice;
 * - `failed` — it could not start (Couldn't start), with the reason as a notice.
 */
export type ExtensionRunState = 'running' | 'on' | 'pending' | 'off' | 'waiting' | 'failed'

export const RUN_STATE_LABEL: Record<ExtensionRunState, string> = {
  running: 'Running',
  on: 'On',
  pending: 'Starts after restart',
  off: 'Off',
  waiting: 'Waiting to start',
  failed: 'Couldn’t start',
}

export type ExtensionProblem =
  // A tampered or invalid signature: it can never be approved as installed.
  | { kind: 'invalid' }
  // It was loaded and failed, this session.
  | { kind: 'error'; message: string }
  // Studio's kill list removed this version: it is switched off.
  | { kind: 'killed'; reason: string; advisoryUrl?: string }

/** Why a module cannot run as installed, whatever its approval, or null. */
export function moduleProblem(
  module: ThirdPartyModuleView,
  rendererLoadState: ThirdPartyRendererLoadState | undefined,
  contributionError?: string,
): ExtensionProblem | null {
  if (module.killed) return { kind: 'killed', ...module.killed }
  if (module.signature === 'invalid' || module.launch.status === 'blocked_invalid') return { kind: 'invalid' }
  if (!isApproved(module)) return null
  if (module.launch.status === 'launch_error') {
    return { kind: 'error', message: module.launch.message ?? copy.settings.extensionsModel.itsMainEntryFailedAt }
  }
  const renderer = module.launch.rendererEntry
  if (renderer?.availability === 'error') {
    return { kind: 'error', message: renderer.message ?? copy.settings.extensionsModel.itsWindowCodeCouldNot }
  }
  if (rendererLoadState?.status === 'error') return { kind: 'error', message: rendererLoadState.message }
  if (contributionError) return { kind: 'error', message: contributionError }
  return null
}

export function problemText(problem: ExtensionProblem): string {
  switch (problem.kind) {
    case 'invalid':
      return 'Its signature doesn’t match its files, so it can’t be approved.'
    case 'error':
      return problem.message
    case 'killed':
      return `Studio switched it off: its kill list removed this version. ${problem.reason}${problem.advisoryUrl ? ` (${problem.advisoryUrl})` : ''}`
  }
}

const hasRendererEntry = (module: ThirdPartyModuleView): boolean =>
  Boolean(module.launch.rendererEntry && module.launch.rendererEntry.availability !== 'none')

/**
 * The state word for an APPROVED module. What a server holds of the installed
 * extensions is read once, at launch, so a worker approved since reads
 * "Starts after restart"; switching one off stops its worker at once, and
 * renderer contributions follow the switch live.
 */
export function runState(
  module: ThirdPartyModuleView,
  enabled: boolean,
  rendererLoadState: ThirdPartyRendererLoadState | undefined,
  contributionError?: string,
): ExtensionRunState {
  if (moduleProblem(module, rendererLoadState, contributionError)) return 'failed'
  const mainLoaded = module.launch.mainLoaded === true
  // Switched off, a worker stops at once.
  if (!enabled) return 'off'
  if (module.launch.hasMainEntry && module.launch.waiting) return 'waiting'
  if (module.launch.hasMainEntry) return mainLoaded ? 'running' : 'pending'
  if (hasRendererEntry(module)) return rendererLoadState?.status === 'loaded' ? 'running' : 'pending'
  return 'on'
}

/** The live enablement intent: an explicit override, else the manifest default. */
export function resolveModuleEnabled(overrides: ModuleEnablementOverrides, module: ThirdPartyModuleView): boolean {
  return overrides[module.manifest.id] ?? module.manifest.defaultEnabled
}

// ── Restart ──────────────────────────────────────────────────────────────

/**
 * Approved, enabled modules whose main entry is ready but was not loaded this
 * session. A module that failed or cannot run on this host is not waiting on a
 * restart, and says so on its own row.
 */
export function modulesAwaitingRestart(
  modules: readonly ThirdPartyModuleView[],
  enabledFor: (module: ThirdPartyModuleView) => boolean,
): ThirdPartyModuleView[] {
  return modules.filter(
    (module) =>
      isApproved(module) &&
      module.launch.status === 'runs_worker' &&
      module.launch.hasMainEntry &&
      module.launch.mainLoaded !== true &&
      enabledFor(module),
  )
}

export function restartBannerTitle(waiting: readonly Pick<ThirdPartyModuleView, 'manifest'>[]): string | null {
  if (waiting.length === 0) return null
  return waiting.length === 1
    ? `Restart Studio to start ${waiting[0]!.manifest.displayName}`
    : `Restart Studio to start ${waiting.length} extensions`
}

// ── Identity ─────────────────────────────────────────────────────────────

/** Where it came from: its publisher, which Studio derived from the install (`local` for a folder). */
export function sourceLabel(
  module: Pick<ThirdPartyModuleView, 'manifest' | 'development'> & Partial<Pick<ThirdPartyModuleView, 'origin'>>,
): string | null {
  // Said plainly wherever it is listed: its code is a working copy, read again on every save.
  if (module.development)
    return module.development.waiting
      ? 'Development folder, waiting to replace the installed one'
      : module.development.overrides
        ? 'Development folder, in place of the installed one'
        : 'Development folder'
  // Where it came from decides the label, never its own words.
  if (module.origin && module.origin.kind !== 'folder' && module.origin.kind !== 'development')
    return module.origin.label
  return module.manifest.publisher === 'local' ? 'Local build' : null
}

/** What a row says of a newer release, or null: one to install, or one held for review and why. */
export function updateText(module: Pick<ThirdPartyModuleView, 'update'>): string | null {
  const update = module.update
  if (!update) return null
  if (update.held === 'access')
    return `Version ${update.version} waits for your review: it asks for ${(update.growth ?? ['more access']).join(', ')}.`
  if (update.held === 'repository')
    return `Version ${update.version} waits for your review: it moved to another repository or folder.`
  if (update.held === 'owner')
    return `Updates are paused: the account that owns it was renamed or changed hands. Uninstall it and install it again to trust the new owner.`
  return `Version ${update.version} is available.`
}

/** Whether it carries an extension.sig that checked out. */
export function isSigned(module: Pick<ThirdPartyModuleView, 'signature'>): boolean {
  return module.signature === 'signed' || module.signature === 'verified'
}

export function signatureLabel(module: Pick<ThirdPartyModuleView, 'signature' | 'development'>): string {
  if (module.development) return 'Not signed: a working copy'
  if (module.signature === 'invalid') return 'Invalid signature'
  if (module.signature === 'verified') return 'Verified'
  return isSigned(module) ? 'Signed' : 'Unsigned'
}

// A folder install's publisher. It names no one, so a row that printed it
// would be reading out a placeholder; the source says "Local build" instead.
const LOCAL_PUBLISHER = 'local'

/** Who published it, when Studio knows someone. */
export function publisherName(manifest: Pick<CapabilityManifest, 'publisher'>): string | null {
  const publisher = manifest.publisher?.trim()
  return publisher && publisher !== LOCAL_PUBLISHER ? publisher : null
}

/** "acme · GitHub · Signed" — publisher, source and signature, each when known. */
export function moduleMeta(module: ThirdPartyModuleView): string {
  return [publisherName(module.manifest), sourceLabel(module), signatureLabel(module)].filter(Boolean).join(' · ')
}

// ── Access ───────────────────────────────────────────────────────────────

export function accessItems(permissions: readonly string[] | undefined): {
  care: AccessItem[]
  standard: AccessItem[]
} {
  const { care, standard } = partitionCapabilityAccess(permissions ?? [])
  const item = (id: string): AccessItem => {
    const access = capabilityAccess(id)
    return { id, title: access.title, ...(access.why ? { why: access.why } : {}) }
  }
  return { care: care.map(item), standard: standard.map(item) }
}

// ── Filter ───────────────────────────────────────────────────────────────

export type ExtensionFilter = 'all' | 'review' | 'on' | 'off'

/** Whether an extension waits on the person's approval. */
export const needsReview = (module: ThirdPartyModuleView): boolean => !isApproved(module)

export function matchesQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return parts.some((part) => part?.toLowerCase().includes(needle))
}

export function moduleMatchesQuery(module: ThirdPartyModuleView, query: string): boolean {
  return matchesQuery(
    query,
    module.manifest.displayName,
    module.manifest.summary,
    module.manifest.publisher,
    module.manifest.id,
  )
}

/** Whether a third-party module belongs under the filter. */
export function moduleMatchesFilter(module: ThirdPartyModuleView, filter: ExtensionFilter, enabled: boolean): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'review':
      return needsReview(module)
    case 'on':
      return !needsReview(module) && enabled
    case 'off':
      return !needsReview(module) && !enabled
  }
}

/** Whether a built-in module belongs under the filter; built-ins never need review. */
export function builtInMatchesFilter(filter: ExtensionFilter, enabled: boolean): boolean {
  if (filter === 'review') return false
  if (filter === 'on') return enabled
  if (filter === 'off') return !enabled
  return true
}
