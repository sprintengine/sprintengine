import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
  BuiltinSkill,
  BuiltinSkillStatus,
  McpSyncInput,
  McpSyncResult,
  MemoryActivityEvent,
  MemoryActivityInstallResult,
  MemoryActivityStatus,
  MemoryActivitySynapse,
  MemoryActivitySynapsesPayload,
  MemoryActivityUninstallResult,
  MemoryGraphIndexResult,
  MemoryPreviewResult,
  MemoryRootStatus,
  StudioAreaSkillChoices,
  StudioAreaSkillId,
} from '../../../packages/studio-protocol/src/public'
import { indexMemoryGraph, readMemoryPreview, resolveMemoryRoot } from '../../main/memory-graph'
import {
  getMemoryActivityStatus,
  getMemoryActivitySynapses,
  installMemoryActivityHook,
  isMemoryActivityInstalled,
  onMemoryActivityEvent,
  onMemoryActivityStatus,
  onMemoryActivitySynapses,
  startMemoryActivityWatcher,
  stopMemoryActivityWatcher,
  uninstallMemoryActivityHook,
} from '../../main/memory-activity'

// What a Studio's agents are set up with beyond their CLIs, as the Studio
// protocol serves it (`memory.*`, `memoryActivity.*`, `mcp.sync`,
// `agentConfig.*`, `builtinSkills.*`, `areaSkills.*`): one domain the RPC
// router answers from, for the app's own windows and every other client
// alike. The services behind it are the core's, composed in every Studio
// (core/studio-agent-services.ts); who may ask is the router's to hold.

export type StudioAgentSetup = {
  resolveMemoryRoot(workspaceRoot: string | null, relativeRoot: string | null): Promise<MemoryRootStatus>
  indexMemory(workspaceRoot: string | null, relativeRoot: string | null): Promise<MemoryGraphIndexResult>
  readMemoryPreview(
    workspaceRoot: string | null,
    relativeRoot: string | null,
    relativePath: string,
  ): Promise<MemoryPreviewResult>
  /** Install the hook and, once it is in, follow it. */
  installMemoryActivity(workspaceRoot: string, memoryRelativeRoot: string): Promise<MemoryActivityInstallResult>
  /** Stop following and take the hook out. */
  uninstallMemoryActivity(workspaceRoot: string): Promise<MemoryActivityUninstallResult>
  startMemoryActivityWatching(workspaceRoot: string, memoryRelativeRoot: string): Promise<void>
  memoryActivityStatus(workspaceRoot: string | null): MemoryActivityStatus
  memoryActivitySynapses(workspaceRoot: string): MemoryActivitySynapse[]
  memoryActivityInstalled(workspaceRoot: string): Promise<boolean>
  onMemoryActivityEvent(listener: (event: MemoryActivityEvent) => void): () => void
  onMemoryActivityStatus(listener: (status: MemoryActivityStatus) => void): () => void
  onMemoryActivitySynapses(listener: (payload: MemoryActivitySynapsesPayload) => void): () => void
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
    resolveMemoryRoot: (workspaceRoot, relativeRoot) => resolveMemoryRoot(workspaceRoot, relativeRoot),
    indexMemory: (workspaceRoot, relativeRoot) => indexMemoryGraph(workspaceRoot, relativeRoot),
    readMemoryPreview: (workspaceRoot, relativeRoot, relativePath) =>
      readMemoryPreview(workspaceRoot, relativeRoot, relativePath),
    async installMemoryActivity(workspaceRoot, memoryRelativeRoot) {
      const result = await installMemoryActivityHook(workspaceRoot, memoryRelativeRoot)
      if (result.ok) await startMemoryActivityWatcher(workspaceRoot, memoryRelativeRoot)
      return result
    },
    uninstallMemoryActivity(workspaceRoot) {
      stopMemoryActivityWatcher(workspaceRoot)
      return uninstallMemoryActivityHook(workspaceRoot)
    },
    startMemoryActivityWatching: async (workspaceRoot, memoryRelativeRoot) => {
      await startMemoryActivityWatcher(workspaceRoot, memoryRelativeRoot)
    },
    memoryActivityStatus: (workspaceRoot) => getMemoryActivityStatus(workspaceRoot),
    memoryActivitySynapses: (workspaceRoot) => getMemoryActivitySynapses(workspaceRoot),
    memoryActivityInstalled: (workspaceRoot) => isMemoryActivityInstalled(workspaceRoot),
    onMemoryActivityEvent: (listener) => onMemoryActivityEvent(listener),
    onMemoryActivityStatus: (listener) => onMemoryActivityStatus(listener),
    onMemoryActivitySynapses: (listener) => onMemoryActivitySynapses(listener),
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
