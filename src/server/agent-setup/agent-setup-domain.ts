import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
  BuiltinSkill,
  BuiltinSkillStatus,
  McpSyncInput,
  McpSyncResult,
  KnowledgeRootStatus,
  StudioAreaSkillChoices,
  StudioAreaSkillId,
} from '../../../packages/studio-protocol/src/public'
import { resolveKnowledgeRoot } from '../../main/knowledge-root'

// What a Studio's agents are set up with beyond their CLIs, as the Studio
// protocol serves it (`knowledge.resolveRoot`, `mcp.sync`,
// `agentConfig.*`, `builtinSkills.*`, `areaSkills.*`): one domain the RPC
// router answers from, for the app's own windows and every other client
// alike. The services behind it are the core's, composed in every Studio
// (core/studio-agent-services.ts); who may ask is the router's to hold.

export type StudioAgentSetup = {
  resolveKnowledgeRoot(workspaceRoot: string | null, relativeRoot: string | null): Promise<KnowledgeRootStatus>
  syncMcp(input: McpSyncInput): Promise<McpSyncResult>
  detectAgentConfig(input: AgentConfigDetectInput): Promise<AgentConfigDetectResult>
  adoptAgentConfig(input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult>
  builtinSkills(): Promise<BuiltinSkill[]>
  builtinSkillStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus>
  areaSkills(): StudioAreaSkillChoices
  setAreaSkillEnabled(skillId: StudioAreaSkillId, enabled: boolean): Promise<StudioAreaSkillChoices>
  dismissAreaSkill(skillId: StudioAreaSkillId): Promise<StudioAreaSkillChoices>
  onAreaSkillsChanged(listener: (choices: StudioAreaSkillChoices) => void): () => void
}

export type StudioAgentSetupDeps = {
  mcp: { sync(input: McpSyncInput): Promise<McpSyncResult> }
  agentConfig: {
    detect(input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult>
    adopt(input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult>
  }
  builtinSkills: {
    list(): Promise<BuiltinSkill[]>
    getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus>
  }
  areaSkills: {
    read(): StudioAreaSkillChoices
    setEnabled(id: StudioAreaSkillId, enabled: boolean): Promise<StudioAreaSkillChoices>
    dismiss(id: StudioAreaSkillId): Promise<StudioAreaSkillChoices>
    onChange(listener: (choices: StudioAreaSkillChoices) => void): () => void
  }
}

export function createStudioAgentSetup(deps: StudioAgentSetupDeps): StudioAgentSetup {
  return {
    resolveKnowledgeRoot: (workspaceRoot, relativeRoot) => resolveKnowledgeRoot(workspaceRoot, relativeRoot),
    syncMcp: (input) => deps.mcp.sync(input),
    detectAgentConfig: (input) => deps.agentConfig.detect(input),
    adoptAgentConfig: (input) => deps.agentConfig.adopt(input),
    builtinSkills: () => deps.builtinSkills.list(),
    builtinSkillStatus: (workspaceRoot, skillId) => deps.builtinSkills.getStatus(workspaceRoot, skillId),
    areaSkills: () => deps.areaSkills.read(),
    setAreaSkillEnabled: (skillId, enabled) => deps.areaSkills.setEnabled(skillId, enabled),
    dismissAreaSkill: (skillId) => deps.areaSkills.dismiss(skillId),
    onAreaSkillsChanged: (listener) => deps.areaSkills.onChange(listener),
  }
}
