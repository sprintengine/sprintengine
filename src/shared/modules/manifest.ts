// Capability module system — shared contracts.
//
// A "capability module" is a self-describing unit that owns one feature end to
// end (git, the editor, the backlog, the memory graph, …) and contributes to
// the extension surfaces it needs. This file holds the process-agnostic types so
// the main, preload, and renderer hosts all speak the same vocabulary.
//
// See docs/extension-authors/drop-in-extensions.md for the author-facing contract.
// Phase 0 ships the contracts, the main-process kernel, and a
// pure enablement resolver; later phases migrate features onto it and add the
// renderer/preload hosts plus the user-facing module chooser.

import type { ModuleResolutionErrorCode, StudioModuleTrustStatus } from '../../../packages/studio-protocol/src/public'

// The manifest and what a Studio says about its installed extensions, as the
// Studio protocol defines them (`extensions-types.ts`), under the names the
// app has always used.

export type {
  CapabilityCategory,
  CapabilityManifest,
  ExtensionManifestView,
  ModuleFileDigests,
  ModuleManifestIssue,
  ModuleResolutionErrorCode,
  ModuleSignature,
  ModuleSource,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleListResult,
  ThirdPartyModuleView,
  ThirdPartyRendererEntriesResult,
  ThirdPartyRendererEntry,
  ThirdPartyRendererEntryView,
} from '../../../packages/studio-protocol/src/public'

// Ids of the bundled (first-party) modules — the reserved set a third-party
// module may not claim (it must not shadow/impersonate a built-in feature).
// This is the explicit cross-process source of truth: neither process can
// derive it alone (main sees only main modules; the renderer can't be imported
// here). MUST be updated when a bundled module is added/renamed — the drift
// guard in src/renderer/src/modules/bundled-ids.test.ts fails if it diverges
// from the actual bundled renderer module manifests.
export const BUNDLED_MODULE_IDS: readonly string[] = [
  'agent-runtime',
  'backlog',
  'canvas',
  'design',
  // RETIRED, still reserved: the Design Wizard (the guided brief) was deleted
  // 2026-09-08. Its id stays here so a third-party module can never install
  // under a built-in name people recognise. Same rule as 'switchboard'.
  'design-wizard',
  'dev-tools',
  'git',
  'memory-graph',
  // RETIRED, still reserved (see 'design-wizard' above).
  'switchboard',
  // RESERVED for the out-of-tree Sprint Engine module, which installs under
  // this id. Reserved rather than bundled so nothing else can claim the name.
  'sprint-engine',
  'review',
  // RETIRED, still reserved: Automations became scheduled agents 2026-09-30.
  // Same rule as 'switchboard'.
  'automations',
  'scheduled-agents',
  // RETIRED, still reserved: the hosted mobile relay was removed 2026-09-27,
  // when the phone moved to pairing over the tailnet. Same rule as 'switchboard'.
  'mobile-relay',
  // RETIRED, still reserved: voice dictation was removed 2026-10-09. Same rule
  // as 'switchboard'.
  'voice-dictation',
]

/**
 * The Canvas module's own default, in the one place both processes can read it.
 *
 * `canvas` is renderer-only, so main has no manifest of it to resolve: the
 * module's surface is a pane tab, and its enablement reaches main only through
 * the window's mirrored registry. Until that mirror carries a `canvas` entry —
 * at start-up, or because the window has not listed it — this is what the
 * canvas tools answer on. Kept here rather than read off the renderer manifest
 * so main never imports renderer code, and asserted against that manifest by
 * the bundled-module drift guard.
 */
export const CANVAS_MODULE_DEFAULT_ENABLED = true

/**
 * The bundled modules whose enablement takes effect WITHOUT an app restart —
 * the `liveModuleIds` the main process hands `applyEnablement` (src/main/index.ts),
 * beside every installed extension. Everything else loads once, at launch, so
 * switching it changes nothing until the app is started again.
 */
export const LIVE_ENABLED_MODULE_IDS: readonly string[] = ['scheduled-agents']

// Trust classification of a third-party module (see module-signature.ts):
// 'trusted' (loadable), 'signed' (valid sig, awaiting user approval), 'unsigned'
// (awaiting approval), 'invalid' (tampered signature; blocked).
/** Whether a module's code is one Studio may run; the Studio protocol's, as a provider list reports it. */
export type ModuleTrustStatus = StudioModuleTrustStatus

/** Showing an extension's folder on this computer: done, or why not. */
export type ThirdPartyModuleRevealResult = { ok: boolean; message?: string }

/**
 * User/workspace enablement overrides, keyed by module id. A `true`/`false`
 * value overrides the manifest's `defaultEnabled`. Core modules ignore
 * overrides. Unknown ids are ignored.
 */
export type ModuleEnablementOverrides = Record<string, boolean>

// Shared by the renderer settings store and the main-process enablement cache
// so both processes normalize persisted/IPC overrides identically: drop empty
// keys and non-boolean values.
export function normalizeModuleOverrides(value: unknown): ModuleEnablementOverrides {
  if (!value || typeof value !== 'object') return {}
  const out: ModuleEnablementOverrides = {}
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0 && typeof enabled === 'boolean') out[key] = enabled
  }
  return out
}

export type ModuleResolutionError = {
  /** The module the error is attributed to (empty for whole-graph errors). */
  id: string
  code: ModuleResolutionErrorCode
  message: string
}

export type ModuleResolution = {
  /** Module ids that should load, ordered so dependencies precede dependents. */
  order: string[]
  /** Module ids intentionally left off (user preference or `defaultEnabled: false`). */
  disabled: string[]
  /** Modules that wanted to load but cannot (broken dependency, conflict, cycle). */
  errors: ModuleResolutionError[]
}
