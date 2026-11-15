// Models an agent CLI reported about itself, and the merged catalog the pickers
// render. Node-free on purpose: `src/shared` cannot import `src/main` (TS6307),
// and the discovery probes that populate this shape live in the main process.
import type { PluginModelOption, PluginModelSelection } from './plugin-manifest'
import { NEW_FOR_MS } from './new-for-days'
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../packages/studio-protocol/src/public'

// One model and one CLI's catalog, as the Studio protocol carries them (`cliModels.*`).
export type { DiscoveredCliModel, DiscoveredCliModelCatalog }

// Which layer a merged row came from. A row present in both reports the
// stronger claim: user > discovered. Never rendered as words — it drives the
// user-added glyph in the Settings CLI detail.
export type CliModelOrigin = 'discovered' | 'user'

export type MergedCliModelOption = PluginModelOption & {
  origin: CliModelOrigin
  // Set on a discovered row whose `firstSeenAt` falls within NEW_FOR_DAYS of
  // the merge's clock: what the picker's "New" chip reads. A row the CLI did
  // not list (a user id alone) is never new.
  isNew?: true
}

// The picker-facing catalog: PluginModelCatalog with every row source-tagged.
// Assignable to PluginModelCatalog, so hosts that only render id/label need no
// change to display a discovered row.
export type MergedCliModelCatalog = {
  options: MergedCliModelOption[]
  allowCustomId: boolean
}

// The rows a CLI's model picker offers, from two sources:
//
//   what the CLI reported  +  the user's own ids
//
// The CLI's list is the list (owner ruling 2026-09-22). This replaced a union
// of a manifest seed, a hosted model list and the discovered rows, which was
// kept because discovery once under-reported and a replacement would have hidden
// working models. The union's cost turned out higher: a model the CLI stopped
// accepting stayed in the picker forever, a label nobody maintained outlived
// the model, and every release meant hand edits in two repositories. The one
// case the union protected — an id the CLI runs but does not advertise — is
// what the user's own ids are for.
//
// The rows are the discovered rows in the CLI's own order, followed by the
// user's ids that the CLI did not list. A model the CLI stops listing
// disappears on the next refresh. Hidden rows (Codex `visibility: "hide"`)
// never reach the catalog; the probe drops them, so this function trusts the
// list it is given.
//
// Until a probe has answered — fresh install, CLI not installed, a CLI with no
// probe (Kimi Code), every probe failing — there are no discovered rows, and
// the list is the user's ids alone. The picker always has the CLI's own row
// above them, which launches with the CLI's default model, so an empty list is
// not an empty picker. The manifest names no models to stand in (owner ruling
// 2026-11-15): a baked-in list is a guess about the person's account and goes
// stale with every release.
//
// Dedupe is by exact `id` and nothing else. An alias the CLI reports (`opus`,
// `default`, `opus[1m]`) is an ordinary row with the CLI's own label, and is
// never collapsed onto a versioned id through `resolvedModel`: that field is
// stale for some rows (measured: `opus[1m]` reported as `claude-opus-4-8[1m]`
// while it actually resolves to `claude-opus-5[1m]`), so trusting it would
// merge two different models and mislabel the survivor.
//
// "New" is per machine: a discovered row is new while its `firstSeenAt` — when
// a probe on this machine first listed the id — is within NEW_FOR_DAYS of
// `now`. The first-ever probe for a CLI writes no `firstSeenAt`, so a fresh
// install does not light up every model. A future `firstSeenAt` (the clock
// moved back) still counts as new, as the Design door reads its own dates.
//
// A persisted choice the CLI no longer lists is not this function's concern:
// the picker renders it as a "Not listed" row and the launch still passes it.
//
// User additions only apply when the plugin declares modelSelection — without
// declared args the launch path could not pass the model anyway.
//
// `removedModels` are ids the person took off this CLI's list in Settings. They
// are dropped from the CLI's own rows, so a refresh that lists them again does
// not bring them back; an id the person also typed is still offered, because
// typing it is the newer word on the matter.
export function mergeCliModelCatalog(
  declared: PluginModelSelection | undefined,
  userModels: string[] | undefined,
  discovered: DiscoveredCliModelCatalog | undefined,
  now: number,
  removedModels?: readonly string[],
): MergedCliModelCatalog | undefined {
  if (!declared) return undefined
  const byId = new Map<string, MergedCliModelOption>()
  const removed = new Set((removedModels ?? []).map((id) => (typeof id === 'string' ? id.trim() : '')))
  const add = (option: MergedCliModelOption): void => {
    const id = option.id.trim()
    if (!id) return
    if (option.origin !== 'user' && removed.has(id)) return
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { ...option, id })
      return
    }
    // An id the user also typed keeps its place and label but reports the
    // stronger claim, which is what the Settings user-added glyph reads.
    if (option.origin === 'user') existing.origin = 'user'
  }
  // Tolerate a catalog that never went through the settings normalizer (a raw
  // IPC payload, a hand-edited profile): a bad discovered layer reads as no
  // answer, and only the user's ids are listed.
  const discoveredModels = (Array.isArray(discovered?.models) ? discovered.models : []).filter(
    (model) => model && typeof model.id === 'string' && model.id.trim(),
  )
  for (const model of discoveredModels) {
    const label = typeof model.displayName === 'string' ? model.displayName.trim() : ''
    add({
      id: model.id,
      ...(label ? { label } : {}),
      origin: 'discovered',
      ...(isRecentlyFirstSeen(model.firstSeenAt, now) ? { isNew: true as const } : {}),
    })
  }
  for (const entry of userModels ?? []) {
    if (typeof entry === 'string') add({ id: entry, origin: 'user' })
  }
  return { options: [...byId.values()], allowCustomId: declared.allowCustomId }
}

/** One row of a CLI's model list in Settings, and whether it can be put back. */
export type CliModelListing = {
  /** What the pickers offer, in their order. */
  listed: MergedCliModelOption[]
  /** What the CLI still offers that the person took off the list. */
  removed: Array<{ id: string; label?: string }>
  /** Every id the CLI offers, removed or not: what a removal has to remember. */
  reportedIds: ReadonlySet<string>
}

// The list Settings edits. `listed` is the merge every picker makes, so what
// the page shows and what a picker offers cannot disagree. A removed id the CLI
// no longer reports has nothing to restore and is not shown; it stays stored,
// so it stays gone if the CLI lists it again.
export function cliModelListing(
  declared: PluginModelSelection | undefined,
  userModels: string[] | undefined,
  discovered: DiscoveredCliModelCatalog | undefined,
  now: number,
  removedModels: readonly string[] | undefined,
): CliModelListing {
  const merged = mergeCliModelCatalog(declared, userModels, discovered, now, removedModels)
  if (!merged) return { listed: [], removed: [], reportedIds: new Set() }
  const removed = new Set(removedModels ?? [])
  const listedIds = new Set(merged.options.map((option) => option.id))
  const offered = mergeCliModelCatalog(declared, undefined, discovered, now)?.options ?? []
  return {
    listed: merged.options,
    removed: offered
      .filter((option) => removed.has(option.id) && !listedIds.has(option.id))
      .map((option) => ({ id: option.id, ...(option.label ? { label: option.label } : {}) })),
    reportedIds: new Set(offered.map((option) => option.id)),
  }
}

function isRecentlyFirstSeen(firstSeenAt: string | undefined, now: number): boolean {
  if (typeof firstSeenAt !== 'string' || !firstSeenAt) return false
  const seen = Date.parse(firstSeenAt)
  if (Number.isNaN(seen)) return false
  return now - seen < NEW_FOR_MS
}
