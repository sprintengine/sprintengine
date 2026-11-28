import type { StudioCliRuntime } from '../../../packages/studio-protocol/src/public'
import { declaredPermissionModes, declaredPermissionPresets, pluginHostedVia } from '../../main/plugin-render'
import { mergeCliModelCatalog, type DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import { cliPickerModels } from '../../shared/cli-model-families'
import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { LoadedPlugin } from '../../shared/plugin-manifest'

// The agent CLIs this Studio can run, as `cliRuntimes.list` answers them on
// the protocol and the gateway's `cli.runtime.list` tool answers them on MCP:
// the CLI plugins it holds and what its own model picker offers for each.
// Every Studio serves it, with or without a desktop shell around it: an SSH
// machine's and a WSL distribution's report the CLIs they run chats with.
// One implementation, so a device, a desktop starting a chat on another
// machine and an agent read the same rows.

export type CliModelSources = {
  /** The discovered catalogs, keyed by CLI id; an unreadable cache reads as none. */
  discovered: Record<string, DiscoveredCliModelCatalog>
  /** The ids the person added for a CLI in Settings. */
  userModels: (cli: string) => readonly string[] | undefined
  /** The ids the person took off a CLI's list in Settings. */
  removedModels?: (cli: string) => readonly string[] | undefined
}

export type StudioCliRuntimesAnswer =
  { ok: true; clis: StudioCliRuntime[] } | { ok: false; code: 'unknown_cli'; message: string }

export type StudioCliRuntimes = {
  /** Every CLI this Studio holds, or the one named; a name it does not hold is refused, not answered empty. */
  list(cli?: string | null): Promise<StudioCliRuntimesAnswer>
}

export type StudioCliRuntimesDeps = {
  /** The loaded CLI plugin manifests. */
  listPlugins(): LoadedPlugin[]
  /**
   * What the model picker here reads besides the manifests: the catalogs each
   * CLI reported about itself and the ids the person added for it. Absent or
   * unreadable, the rows go without a `catalog`.
   */
  readCliModelSources?(): Promise<CliModelSources>
  now?(): number
}

// One agent CLI as the list reports it. Everything here is manifest-declared;
// the models are the `catalog`'s (cliRuntimeCatalog below), because a manifest
// names none.
function cliRuntimeProjection(plugin: LoadedPlugin): StudioCliRuntime {
  const { manifest } = plugin
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    source: plugin.source,
    binary: manifest.binary,
    // Hooks-only selectability (decision of record 2026-08-31): declared, not
    // probed — true exactly when the manifest carries an agentStateSpec. Rows
    // are marked rather than omitted so a remote caller holding a stale id
    // learns WHY it is refused instead of seeing the CLI vanish.
    agentSelectable: Boolean(manifest.agentStateSpec),
    supportsModelSelection: Boolean(manifest.modelSelection),
    allowCustomModelId: manifest.modelSelection?.allowCustomId === true,
    reasoningLevels: (manifest.reasoningSelection?.levels ?? []).map((level) => ({
      id: level.id,
      ...(level.label ? { label: level.label } : {}),
    })),
    defaultReasoningLevel: manifest.reasoningSelection?.default ?? null,
    // The presets a launch on this CLI can honour: `none` always (it passes no
    // flag), each other one only where the manifest names its setting.
    permissionPresets: declaredPermissionPresets(manifest),
    // The CLI's modes under its own names, each with the preset it runs at. A
    // caller names a mode by its id (`permissionMode` on agent.launch and
    // conversation.create), or the preset for that preset's own mode. `readOnly`
    // marks a mode the CLI declares read-only.
    permissionModes: declaredPermissionModes(manifest).map((mode) => ({
      id: mode.id,
      label: mode.label,
      preset: mode.level,
      ...(mode.readOnly ? { readOnly: true } : {}),
    })),
  }
}

// What the model picker here offers for one CLI, for a client that draws the
// same picker (the phone's New chat). The rows are the picker's own: the same
// merge of the CLI's reported list and the person's ids
// (`mergeCliModelCatalog`), grouped into the same families
// (`cliPickerModels`), named the way its provider line names them. The row's
// top-level `models`, which answered a manifest's built-in list, is gone with
// that list; a phone that reads it finds none and reads this instead.
function cliRuntimeCatalog(plugin: LoadedPlugin, sources: CliModelSources, now: number): Record<string, unknown> {
  const { manifest } = plugin
  const merged = mergeCliModelCatalog(
    manifest.modelSelection ? { allowCustomId: manifest.modelSelection.allowCustomId === true } : undefined,
    [...(sources.userModels(manifest.id) ?? [])],
    sources.discovered[manifest.id],
    now,
    sources.removedModels?.(manifest.id),
  )
  const hostedVia = pluginHostedVia(manifest) ?? null
  return {
    conversational: conversationProviderForCli(manifest.id) !== null,
    hostedVia,
    providerLabel: hostedVia === 'claude-code' ? `${manifest.displayName} · via Claude Code` : manifest.displayName,
    allowCustomModelId: merged?.allowCustomId === true,
    models: merged ? cliPickerModels(merged.options) : [],
  }
}

export function createStudioCliRuntimes(deps: StudioCliRuntimesDeps): StudioCliRuntimes {
  return {
    async list(wanted) {
      const plugins = deps.listPlugins()
      if (wanted && !plugins.some((plugin) => plugin.manifest.id === wanted)) {
        return {
          ok: false,
          code: 'unknown_cli',
          message: `No agent CLI "${wanted}" is registered in this app. Call cli.runtime.list with no arguments for the ids it holds.`,
        }
      }
      // Read once for every row, and never fatal: a cache that cannot be read
      // leaves the rows as they were before they carried a catalog.
      const sources = deps.readCliModelSources ? await deps.readCliModelSources().catch(() => null) : null
      const now = (deps.now ?? Date.now)()
      return {
        ok: true,
        clis: plugins
          .filter((plugin) => !wanted || plugin.manifest.id === wanted)
          .map((plugin) => ({
            ...cliRuntimeProjection(plugin),
            ...(sources ? { catalog: cliRuntimeCatalog(plugin, sources, now) } : {}),
          })),
      }
    },
  }
}
