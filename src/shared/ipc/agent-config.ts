// Importing configuration from another agent CLI: the Studio protocol's shapes
// (`agentConfig.*`). ../electron-api.ts re-exports everything here.

export type {
  AgentConfigImportSource,
  AgentConfigDetectedMcpServer,
  AgentConfigDetectedSkill,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
  AgentConfigAdoptInput,
  AgentConfigAdoptedMcpServer,
  AgentConfigAdoptedSkill,
  AgentConfigAdoptResult,
} from '../../../packages/studio-protocol/src/public'
