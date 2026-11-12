// How an agent runs, and detecting and installing its CLI: the Studio
// protocol's shapes (`agents.ts`, `agent-settings.ts`), under the names the app
// has always used. ../electron-api.ts re-exports everything here.

export type {
  AgentExecutionMode,
  CliPermissionPreset,
  CliRuntimeSettings,
  McpClientTarget,
  McpTransport,
  CliDetectResult,
  CliInstallMethodInfo,
  CliInstallInput,
  CliInstallResult,
} from '../../../packages/studio-protocol/src/public'
