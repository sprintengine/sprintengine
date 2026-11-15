import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  HostedCardFeedReadResult,
  HostedSourcesFeedReadResult,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
  PluginRegistryListResult,
  StudioPluginStatus,
} from '../../../packages/studio-protocol/src/public'
import { renderAgentLaunchPreview } from '../../main/agent-launch-render'
import { detectAgentCliAvailability } from '../../main/cli-availability'
import { createExtensionScaffoldHandlers } from '../../main/extension-scaffold'
import {
  cardFeedFailure,
  createHostedFeeds,
  hostedFeedClients,
  sourcesFeedFailure,
  type HostedFeedClients,
  type HostedFeeds,
} from '../../main/hosted-feed/hosted-feeds'
import {
  createStudioMarketplace,
  type StudioMarketplace,
  type StudioMarketplaceDeps,
} from '../../main/marketplace/studio-marketplace'
import type { McpConfigService } from '../../main/mcp-config-service'
import { getPluginManifest, listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { permissionRenderKey } from '../../main/plugin-render'
import type { StudioPaths } from '../platform/studio-paths'

// What a desktop's Studio is extended with beyond its modules, as the Studio
// protocol serves it (`extensions`): the marketplace and installing from it,
// the agent CLIs' plugin catalogue, Studio's own plugin in a workspace,
// building an extension, and the hosted feeds. The same domain in process and
// out of process; nothing here needs Electron. The agents' `extension.*` and
// `plugin.*` tools and a card's `install.module` go through it too, so a
// window, a tool and a card reach one marketplace and one scaffold.

export type StudioExtensions = {
  readonly marketplace: StudioMarketplace
  readonly scaffold: ReturnType<typeof createExtensionScaffoldHandlers>
  readonly feeds: HostedFeeds
  cliPlugins(): PluginRegistryListResult
  cliAvailability(input: PluginDetectAvailabilityInput): Promise<PluginAvailabilityResult>
  launchPreview(input: AgentLaunchPreviewInput): AgentLaunchPreviewResult
  /** Studio's own plugin in a workspace; null where no process here installs it. */
  studioPluginStatus(workspaceRoot: string | null): Promise<StudioPluginStatus> | null
  cardFeed(): Promise<HostedCardFeedReadResult>
  sourcesFeed(): Promise<HostedSourcesFeedReadResult>
}

export type StudioExtensionsDeps = {
  paths: StudioPaths
  mcpConfig: () => McpConfigService
  /** The workspaces the Studio has open: where an install may write MCP configs and skill copies. */
  openWorkspaceRoots: () => string[]
  /** What is installed or trusted here changed. */
  changed?: () => void
  /**
   * Studio's own plugin in a workspace, from the process that installs it
   * into every workspace it opens (the desktop's shell).
   */
  studioPluginStatus?: (workspaceRoot: string | null) => Promise<StudioPluginStatus>
  /** Test seams. */
  feedClients?: () => HostedFeedClients
  marketplace?: Pick<StudioMarketplaceDeps, 'registryReader' | 'fetcher'>
}

const failed = (error: unknown) => ({
  ok: false as const,
  message: error instanceof Error ? error.message : String(error),
})

export function createStudioExtensions(deps: StudioExtensionsDeps): StudioExtensions {
  const marketplace = createStudioMarketplace({
    dataDir: () => deps.paths.dataDir(),
    mcpConfig: deps.mcpConfig,
    openWorkspaceRoots: deps.openWorkspaceRoots,
    ...(deps.changed ? { changed: deps.changed } : {}),
    ...deps.marketplace,
  })
  const feeds = createHostedFeeds(deps.feedClients ?? (() => hostedFeedClients(deps.paths)))
  return {
    marketplace,
    scaffold: createExtensionScaffoldHandlers(),
    feeds,
    cliPlugins() {
      try {
        return { ok: true, plugins: listPluginRegistryEntries() }
      } catch (error) {
        return failed(error)
      }
    },
    async cliAvailability(input) {
      try {
        return { ok: true, availability: await detectAgentCliAvailability(input) }
      } catch (error) {
        return failed(error)
      }
    },
    // A launch's receipt line, rendered by the launch's own function so it
    // cannot drift from what the launch runs; a client's catalogue withholds argv.
    launchPreview(input) {
      try {
        const { cliPermissionMode, ...rest } = input
        const preset = rest.cliPermissionPreset
        return {
          ok: true,
          preview: renderAgentLaunchPreview({
            ...rest,
            ...(preset
              ? { cliPermissionPreset: permissionRenderKey(getPluginManifest(input.cli), preset, cliPermissionMode) }
              : {}),
          }),
        }
      } catch (error) {
        return failed(error)
      }
    },
    studioPluginStatus: (workspaceRoot) => deps.studioPluginStatus?.(workspaceRoot) ?? null,
    cardFeed: () => feeds.cardFeed().catch(cardFeedFailure),
    sourcesFeed: () => feeds.sourcesFeed().catch(sourcesFeedFailure),
  }
}
