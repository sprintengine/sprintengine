import {
  STUDIO_AGENT_SETUP_CAPABILITY,
  type AgentConfigAdoptInput,
  type AgentConfigAdoptResult,
  type AgentConfigDetectInput,
  type AgentConfigDetectResult,
  type BuiltinSkill,
  type BuiltinSkillStatus,
  type McpSyncInput,
  type McpSyncResult,
  type KnowledgeRootStatus,
  type StudioAreaSkillChoices,
  type StudioAreaSkillId,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to what its Studio's agents are set up with beyond their
// CLIs: the Studio protocol's `knowledge.resolveRoot`, `mcp.sync`,
// `agentConfig.*`, `builtinSkills.*` and `areaSkills.*`, over the window's own
// connection, as every other client reaches them. The members keep the names
// the window has always called them by, so a caller changes only where it
// imports them from. A follow (`on…`) is kept across reconnects and returns
// its unsubscriber.

type Workspace = { workspaceRoot: string | null }
type KnowledgeRoot = Workspace & { relativeRoot: string | null }

export type AgentSetupApi = {
  knowledgeResolveRoot(input: KnowledgeRoot): Promise<KnowledgeRootStatus>
  mcpSync(input: McpSyncInput): Promise<McpSyncResult>
  detectExistingAgentConfig(input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult>
  adoptAgentConfig(input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult>
  builtinSkillsList(): Promise<BuiltinSkill[]>
  builtinSkillStatus(input: { workspaceRoot: string | null; skillId: string }): Promise<BuiltinSkillStatus>
  /** The built-in plugin's area skills, opted into one by one and machine-wide. */
  studioAreaSkillsGet(): Promise<StudioAreaSkillChoices>
  studioAreaSkillsSetEnabled(input: { skillId: StudioAreaSkillId; enabled: boolean }): Promise<StudioAreaSkillChoices>
  /** Turn a surface's suggestion down; the skill stays a switch in Settings. */
  studioAreaSkillsDismiss(input: { skillId: StudioAreaSkillId }): Promise<StudioAreaSkillChoices>
  onStudioAreaSkillsChanged(cb: (choices: StudioAreaSkillChoices) => void): () => void
}

const UNSERVED = 'This Studio is older than this app and does not serve its agents’ setup. Update it to use it here.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_AGENT_SETUP_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

function follow<T>(topic: 'areaSkills.changed', cb: (payload: T) => void): () => void {
  return followWindowStudioPush({
    topic,
    params: {},
    capability: STUDIO_AGENT_SETUP_CAPABILITY,
    onPayload: (payload) => cb(payload as T),
  })
}

export { windowHasStudio } from './windowStudioClient'

export const agentSetupApi: AgentSetupApi = {
  knowledgeResolveRoot: ({ workspaceRoot, relativeRoot }) =>
    call('knowledge.resolveRoot', { workspaceFolder: workspaceRoot, relativeRoot }),
  mcpSync: (input) => call('mcp.sync', { ...input, commandId: randomId() }),
  detectExistingAgentConfig: (input = {}) => call('agentConfig.detect', input),
  adoptAgentConfig: (input) => call('agentConfig.adopt', { ...input, commandId: randomId() }),
  builtinSkillsList: async () => (await call('builtinSkills.list', {})).skills,
  builtinSkillStatus: ({ workspaceRoot, skillId }) =>
    call('builtinSkills.status', { workspaceFolder: workspaceRoot, skillId }),
  studioAreaSkillsGet: () => call('areaSkills.get', {}),
  studioAreaSkillsSetEnabled: (input) => call('areaSkills.setEnabled', { ...input, commandId: randomId() }),
  studioAreaSkillsDismiss: (input) => call('areaSkills.dismiss', { ...input, commandId: randomId() }),
  onStudioAreaSkillsChanged: (cb) => follow('areaSkills.changed', cb),
}
