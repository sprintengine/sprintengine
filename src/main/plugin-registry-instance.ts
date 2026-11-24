import { existsSync } from 'fs'
import { join } from 'path'

import type {
  ConversationProviderListEntry,
  LoadedConversationProvider,
  LoadedPlugin,
  PluginManifest,
  PluginRegistryListEntry,
} from '../shared/plugin-manifest'
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryOptions,
  type PluginRegistryLoadReport,
} from './plugin-registry'
import { studioPlatform } from '../server/platform/platform'
import { projectedProviders, type ProjectedProvider } from '../server/extensions/agent-contributions/projection'

// Lazy-initialized singleton plugin registry for the main process. The launch
// path needs synchronous access to plugin manifests; this module loads the
// bundled ones once on first use from the appropriate bundled-resource
// location, and reads the providers installed extensions add on each lookup.

let registry: PluginRegistry | null = null

// The platform is read when the registry is first wanted, never at import, so
// a test that never reaches `ensureRegistry()` needs no platform.
function resolveBundledPluginRoot(): string {
  const paths = studioPlatform().paths
  const resourcesDir = paths.resourcesDir()
  if (paths.isPackaged() && resourcesDir) {
    const packaged = join(resourcesDir, 'plugins')
    if (existsSync(packaged)) return packaged
  }

  const appRoot = paths.appRoot()
  const candidates = [
    join(process.cwd(), 'resources', 'plugins'),
    ...(appRoot ? [join(appRoot, 'resources', 'plugins')] : []),
    join(__dirname, '..', '..', 'resources', 'plugins'),
    join(__dirname, '..', '..', '..', 'resources', 'plugins'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function ensureRegistry(): PluginRegistry {
  if (registry) return registry
  registry = createPluginRegistry(createAppPluginRegistryOptions(resolveBundledPluginRoot()))
  registry.loadSync()
  return registry
}

export function createAppPluginRegistryOptions(
  bundledRoot: string = resolveBundledPluginRoot(),
  dataDir: () => string = () => studioPlatform().paths.dataDir(),
): PluginRegistryOptions {
  return {
    bundledRoot,
    extensionProviders: () => projectedProviders(dataDir()).map(extensionProviderOf),
  }
}

/**
 * An extension's provider as the registry holds one: OpenAI-compatible and
 * declarative, its key (when it takes one) entered in Settings and never read
 * from the environment, the manifest carrying no variable name to read.
 */
export function extensionProviderOf(provider: ProjectedProvider & { extension: string }): LoadedConversationProvider {
  return {
    manifest: {
      kind: 'provider',
      id: provider.id,
      displayName: provider.name,
      version: 1,
      providerType: 'model-provider',
      models: provider.models.map((model) => ({ id: model.id, ...(model.name ? { displayName: model.name } : {}) })),
      ...(provider.apiKey ? { auth: { type: 'api-key' as const, label: provider.apiKey.label } } : {}),
      adapter: { kind: 'declarative' },
      openaiCompatible: {
        baseUrl: provider.baseUrl,
        ...(provider.chatCompletionsPath ? { chatCompletionsPath: provider.chatCompletionsPath } : {}),
        ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
      },
    },
    source: 'extension',
    manifestPath: '',
    pluginRoot: '',
    adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
  }
}

/** The ids an extension's provider may not take: every built-in CLI's and provider's. */
export function bundledRegistryIds(): ReadonlySet<string> {
  const reg = ensureRegistry()
  return new Set([
    ...reg.loaded().map((plugin) => plugin.manifest.id),
    ...reg
      .loadedConversationProviders()
      .filter((provider) => provider.source === 'bundled')
      .map((provider) => provider.manifest.id),
  ])
}

export function getPluginRegistry(): PluginRegistry {
  return ensureRegistry()
}

export function getPluginById(id: string): LoadedPlugin | undefined {
  return ensureRegistry().get(id)
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return ensureRegistry().get(id)?.manifest
}

export function listPluginRegistryEntries(): PluginRegistryListEntry[] {
  return ensureRegistry().list()
}

export function listConversationProviderRegistryEntries(): ConversationProviderListEntry[] {
  return ensureRegistry().listConversationProviders()
}

export function getConversationProviderById(id: string): LoadedConversationProvider | undefined {
  return ensureRegistry().getConversationProvider(id)
}

// Test-only: lets unit tests substitute a registry built from a fixture root.
export function __setPluginRegistryForTest(custom: PluginRegistry, _report?: PluginRegistryLoadReport): void {
  registry = custom
}

export function __resetPluginRegistryForTest(): void {
  registry = null
}
