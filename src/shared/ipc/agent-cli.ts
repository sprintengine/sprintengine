// The agent CLIs' availability and launch previews, as the Studio protocol
// defines them (`extensions-types.ts`), under the names the app has always
// used. ../electron-api.ts re-exports everything here.

export type {
  AgentCliAvailabilityMap,
  AgentLaunchPreview,
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  CliAvailability,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
} from '../../../packages/studio-protocol/src/public'
