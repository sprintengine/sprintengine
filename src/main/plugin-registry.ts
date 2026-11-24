import { readFile, readdir, stat } from 'fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { isAbsolute, join, resolve } from 'path'

import type {
  ConversationProviderAdapterClassification,
  ConversationProviderListEntry,
  ConversationProviderManifest,
  LoadedConversationProvider,
  LoadedPlugin,
  PluginManifestValidationIssue,
  PluginManifestValidationResult,
  PluginRegistryListEntry,
} from '../shared/plugin-manifest'

import { validateManifestStructure } from './plugin-manifest-validate'
import { declaredPermissionModes, declaredPermissionPresets, pluginHostedVia } from './plugin-render'

// The agent CLIs and the conversation providers Studio knows. The CLIs and
// Studio's own providers ship with the app (`resources/plugins/<id>/plugin.json`);
// a provider an extension adds (`contributes.providers` in its extension.json)
// is read live from what the installed extensions project
// (server/extensions/agent-contributions), under an id its install key
// namespaces, so it can never take a built-in's.

export type PluginRegistryOptions = {
  bundledRoot: string
  /** The providers installed extensions add now: read on every lookup, so an install or an uninstall holds at once. */
  extensionProviders?: () => LoadedConversationProvider[]
}

export type PluginRegistry = {
  load: () => Promise<PluginRegistryLoadReport>
  loadSync: () => PluginRegistryLoadReport
  list: () => PluginRegistryListEntry[]
  listConversationProviders: () => ConversationProviderListEntry[]
  loaded: () => LoadedPlugin[]
  loadedConversationProviders: () => LoadedConversationProvider[]
  get: (id: string) => LoadedPlugin | undefined
  getConversationProvider: (id: string) => LoadedConversationProvider | undefined
  validateManifestSource: (source: string) => PluginManifestValidationResult
}

export type PluginRegistryLoadReport = {
  loaded: LoadedPlugin[]
  loadedConversationProviders: LoadedConversationProvider[]
  rejected: Array<{
    manifestPath: string
    issues: PluginManifestValidationIssue[]
  }>
}

export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>()
  const providers = new Map<string, LoadedConversationProvider>()

  // An extension's provider id holds its install key (`<publisher>.<id>/…`),
  // which no built-in id does; one that somehow matched a built-in is left out
  // rather than allowed to stand in for it.
  function extensionProviders(): LoadedConversationProvider[] {
    return (options.extensionProviders?.() ?? []).filter(
      (provider) => !plugins.has(provider.manifest.id) && !providers.has(provider.manifest.id),
    )
  }

  function allProviders(): LoadedConversationProvider[] {
    return [...providers.values(), ...extensionProviders()]
  }

  function bundledReport(entries: Array<BundledEntry>): PluginRegistryLoadReport {
    plugins.clear()
    providers.clear()
    const report: PluginRegistryLoadReport = { loaded: [], loadedConversationProviders: [], rejected: [] }
    for (const entry of entries) {
      if ('issues' in entry) {
        report.rejected.push(entry)
        continue
      }
      const { manifest, manifestPath, pluginRoot } = entry
      if (manifest.kind === 'provider') {
        const provider: LoadedConversationProvider = {
          manifest,
          source: 'bundled',
          manifestPath,
          pluginRoot,
          adapter: classifyBundledProviderAdapter(manifest, pluginRoot),
        }
        providers.set(manifest.id, provider)
        report.loadedConversationProviders.push(provider)
      } else {
        const plugin: LoadedPlugin = { manifest, source: 'bundled', manifestPath, pluginRoot }
        plugins.set(manifest.id, plugin)
        report.loaded.push(plugin)
      }
    }
    return report
  }

  return {
    async load(): Promise<PluginRegistryLoadReport> {
      return bundledReport(await readBundledRoot(resolveRoot(options.bundledRoot)))
    },

    loadSync(): PluginRegistryLoadReport {
      return bundledReport(readBundledRootSync(resolveRoot(options.bundledRoot)))
    },

    list(): PluginRegistryListEntry[] {
      return Array.from(plugins.values()).map(manifestToListEntry)
    },

    listConversationProviders(): ConversationProviderListEntry[] {
      return allProviders().map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        source: p.source,
        version: p.manifest.version,
        providerType: p.manifest.providerType,
        models: p.manifest.models,
        supportsDynamicModels: Boolean(p.manifest.openaiCompatible?.modelsPath),
        credentialSource: p.manifest.providerType === 'agent-harness' ? 'native' : p.manifest.auth ? 'api-key' : 'none',
        adapter: p.adapter,
      }))
    },

    loaded(): LoadedPlugin[] {
      return Array.from(plugins.values())
    },

    loadedConversationProviders(): LoadedConversationProvider[] {
      return allProviders()
    },

    get(id: string): LoadedPlugin | undefined {
      return plugins.get(id)
    },

    getConversationProvider(id: string): LoadedConversationProvider | undefined {
      return providers.get(id) ?? extensionProviders().find((provider) => provider.manifest.id === id)
    },

    validateManifestSource,
  }
}

type BundledEntry =
  | {
      manifest: LoadedPlugin['manifest'] | ConversationProviderManifest
      manifestPath: string
      pluginRoot: string
    }
  | PluginRegistryLoadReport['rejected'][number]

// One bundled folder's plugin.json, validated, its id held to its folder's name.
function bundledEntry(entry: string, pluginRoot: string, read: () => string): BundledEntry | null {
  const manifestPath = join(pluginRoot, 'plugin.json')
  if (!existsSync(manifestPath)) return null
  let raw: string
  try {
    raw = read()
  } catch (err) {
    return { manifestPath, issues: [{ path: '', message: `Could not read plugin.json: ${formatError(err)}` }] }
  }
  const result = validateManifestSource(raw)
  if (!result.ok) return { manifestPath, issues: result.issues }
  if (result.manifest.id !== entry) {
    return {
      manifestPath,
      issues: [
        {
          path: 'id',
          message: `Plugin id "${result.manifest.id}" does not match its containing directory "${entry}".`,
        },
      ],
    }
  }
  return { manifest: result.manifest, manifestPath, pluginRoot }
}

async function readBundledRoot(root: string): Promise<BundledEntry[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root).catch(() => [] as string[])
  const out: BundledEntry[] = []
  for (const entry of entries.sort()) {
    const pluginRoot = join(root, entry)
    const isDir = await stat(pluginRoot).then(
      (info) => info.isDirectory(),
      () => false,
    )
    if (!isDir) continue
    const raw = await readFile(join(pluginRoot, 'plugin.json'), 'utf-8').catch((error: unknown) => error)
    const found = bundledEntry(entry, pluginRoot, () => {
      if (typeof raw !== 'string') throw raw
      return raw
    })
    if (found) out.push(found)
  }
  return out
}

function readBundledRootSync(root: string): BundledEntry[] {
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const out: BundledEntry[] = []
  for (const entry of entries.sort()) {
    const pluginRoot = join(root, entry)
    try {
      if (!statSync(pluginRoot).isDirectory()) continue
    } catch {
      continue
    }
    const found = bundledEntry(entry, pluginRoot, () => readFileSync(join(pluginRoot, 'plugin.json'), 'utf-8'))
    if (found) out.push(found)
  }
  return out
}

export function validateManifestSource(source: string): PluginManifestValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '', message: `plugin.json is not valid JSON: ${formatError(err)}` }],
    }
  }
  return validateManifestStructure(parsed)
}

// Studio's own providers are declarative (an OpenAI-compatible endpoint). A
// bundled executable adapter runs only when its entry's bytes match the hash
// its manifest names.
function classifyBundledProviderAdapter(
  manifest: ConversationProviderManifest,
  pluginRoot: string,
): ConversationProviderAdapterClassification {
  const adapter = manifest.adapter ?? { kind: 'declarative' as const }
  if (adapter.kind === 'declarative') {
    return { kind: 'declarative', execution: 'declarative', trust: 'not_required' }
  }
  let digest: string | null = null
  try {
    digest = createHash('sha256')
      .update(readFileSync(resolve(pluginRoot, adapter.entry)))
      .digest('hex')
  } catch {
    digest = null
  }
  if (digest === null || digest !== adapter.sha256.toLowerCase()) {
    return {
      kind: 'trusted-executable',
      execution: 'blocked',
      trust: 'invalid',
      entry: adapter.entry,
      trustError:
        digest === null
          ? 'Executable provider adapter entry is unavailable.'
          : 'Executable provider adapter entry hash does not match its manifest.',
    }
  }
  return { kind: 'trusted-executable', execution: 'executable', trust: 'trusted', entry: adapter.entry }
}

function resolveRoot(root: string): string {
  if (isAbsolute(root)) return root
  return resolve(process.cwd(), root)
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function manifestToListEntry(plugin: LoadedPlugin): PluginRegistryListEntry {
  const modelSelection = plugin.manifest.modelSelection
  const reasoningSelection = plugin.manifest.reasoningSelection
  const skillIntegration = plugin.manifest.skillIntegration
  const auth = plugin.manifest.auth
  const hostedVia = pluginHostedVia(plugin.manifest)
  return {
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    source: plugin.source,
    version: plugin.manifest.version,
    binary: plugin.manifest.binary,
    // Resume capabilities travel to the renderer so it can decide conversation
    // resume synchronously (see PluginRegistryListEntry / agent-cli-resume.ts).
    resumeSession: plugin.manifest.capabilities.resumeSession,
    sessionIdFromCaller: plugin.manifest.capabilities.sessionIdFromCaller,
    // Hooks are the only supported status mechanism (decision of record,
    // 2026-08-31): a CLI without an agentStateSpec cannot report authoritative
    // agent state and is not offered as an agent. Projected as a boolean so
    // every picker gates on the manifest without reaching the main process.
    agentStateCapable: Boolean(plugin.manifest.agentStateSpec),
    permissionPresets: declaredPermissionPresets(plugin.manifest),
    permissionModes: declaredPermissionModes(plugin.manifest),
    // Only the label crosses to the renderer; the secret value never does.
    ...(auth ? { auth: { label: auth.label } } : {}),
    ...(hostedVia ? { hostedVia } : {}),
    // Renderer pickers need whether a model can be chosen, not the arg templates.
    ...(modelSelection ? { modelSelection: { allowCustomId: modelSelection.allowCustomId ?? false } } : {}),
    // Renderer pickers need the levels + default, not the arg templates.
    ...(reasoningSelection
      ? {
          reasoningSelection: {
            levels: reasoningSelection.levels.map((level) => ({
              id: level.id,
              ...(level.label ? { label: level.label } : {}),
            })),
            ...(reasoningSelection.default ? { default: reasoningSelection.default } : {}),
          },
        }
      : {}),
    ...(skillIntegration
      ? {
          skillIntegration: {
            support: skillIntegration.support,
            harnessId: skillIntegration.harnessId,
            installTargets: (skillIntegration.installTargets ?? []).map((target) => ({
              scope: target.scope,
              path: target.path,
              format: target.format,
              restartRequired: target.restartRequired === true,
            })),
            ...(skillIntegration.invocation
              ? {
                  invocation: {
                    ...skillIntegration.invocation,
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}
