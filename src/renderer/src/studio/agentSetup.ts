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
  type MemoryActivityEvent,
  type MemoryActivityInstallResult,
  type MemoryActivityStatus,
  type MemoryActivitySynapse,
  type MemoryActivitySynapsesPayload,
  type MemoryActivityUninstallResult,
  type MemoryGraphIndexResult,
  type MemoryPreviewResult,
  type MemoryRootStatus,
  type StudioAreaSkillChoices,
  type StudioAreaSkillId,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to what its Studio's agents are set up with beyond their
// CLIs: the Studio protocol's `memory.*`, `memoryActivity.*`, `mcp.sync`,
// `agentConfig.*`, `builtinSkills.*` and `areaSkills.*`, over the window's own
// connection, as every other client reaches them. The members keep the names
// the window has always called them by, so a caller changes only where it
// imports them from. A follow (`on…`) is kept across reconnects and returns
// its unsubscriber.

type Workspace = { workspaceRoot: string | null }
type MemoryRoot = Workspace & { relativeRoot: string | null }
type Hook = Workspace & { memoryRelativeRoot: string | null }

export type AgentSetupApi = {
  memoryResolveRoot(input: MemoryRoot): Promise<MemoryRootStatus>
  memoryIndex(input: MemoryRoot): Promise<MemoryGraphIndexResult>
  memoryReadPreview(input: MemoryRoot & { relativePath: string }): Promise<MemoryPreviewResult>
  memoryActivityInstall(input: Hook): Promise<MemoryActivityInstallResult>
  memoryActivityUninstall(input: Workspace): Promise<MemoryActivityUninstallResult>
  memoryActivityStartWatching(input: Hook): Promise<{ ok: true }>
  memoryActivityGetStatus(input: Workspace): Promise<MemoryActivityStatus>
  memoryActivityGetSynapses(input: Workspace): Promise<MemoryActivitySynapse[]>
  memoryActivityIsInstalled(input: Workspace): Promise<boolean>
  onMemoryActivityEvent(cb: (event: MemoryActivityEvent) => void): () => void
  onMemoryActivityStatus(cb: (status: MemoryActivityStatus) => void): () => void
  onMemoryActivitySynapses(cb: (payload: MemoryActivitySynapsesPayload) => void): () => void
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

const UNSERVED =
  'This Studio does not serve its agents’ setup while it runs in its own process (a preview setting). Turn that off in Settings to use it.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_AGENT_SETUP_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

function follow<T>(
  topic:
    'memoryActivity.events' | 'memoryActivity.statusChanged' | 'memoryActivity.synapsesChanged' | 'areaSkills.changed',
  cb: (payload: T) => void,
): () => void {
  return followWindowStudioPush({
    topic,
    params: {},
    capability: STUDIO_AGENT_SETUP_CAPABILITY,
    onPayload: (payload) => cb(payload as T),
  })
}

export { windowHasStudio } from './windowStudioClient'

const memoryRoot = ({ workspaceRoot, relativeRoot }: MemoryRoot) => ({ workspaceFolder: workspaceRoot, relativeRoot })

export const agentSetupApi: AgentSetupApi = {
  memoryResolveRoot: (input) => call('memory.resolveRoot', memoryRoot(input)),
  memoryIndex: (input) => call('memory.index', memoryRoot(input)),
  memoryReadPreview: (input) => call('memory.readPreview', { ...memoryRoot(input), relativePath: input.relativePath }),
  memoryActivityInstall: async ({ workspaceRoot, memoryRelativeRoot }) => {
    if (!workspaceRoot || !memoryRelativeRoot)
      return { ok: false, message: 'Workspace and knowledge root are required.' }
    return call('memoryActivity.install', { commandId: randomId(), workspaceFolder: workspaceRoot, memoryRelativeRoot })
  },
  memoryActivityUninstall: async ({ workspaceRoot }) => {
    if (!workspaceRoot) return { ok: false, message: 'Workspace root is required.' }
    return call('memoryActivity.uninstall', { commandId: randomId(), workspaceFolder: workspaceRoot })
  },
  memoryActivityStartWatching: async ({ workspaceRoot, memoryRelativeRoot }) => {
    if (workspaceRoot && memoryRelativeRoot)
      await call('memoryActivity.startWatching', { workspaceFolder: workspaceRoot, memoryRelativeRoot })
    return { ok: true }
  },
  memoryActivityGetStatus: ({ workspaceRoot }) => call('memoryActivity.status', { workspaceFolder: workspaceRoot }),
  memoryActivityGetSynapses: async ({ workspaceRoot }) =>
    workspaceRoot ? (await call('memoryActivity.synapses', { workspaceFolder: workspaceRoot })).synapses : [],
  memoryActivityIsInstalled: async ({ workspaceRoot }) =>
    workspaceRoot ? (await call('memoryActivity.isInstalled', { workspaceFolder: workspaceRoot })).installed : false,
  onMemoryActivityEvent: (cb) => follow('memoryActivity.events', cb),
  onMemoryActivityStatus: (cb) => follow('memoryActivity.statusChanged', cb),
  onMemoryActivitySynapses: (cb) => follow('memoryActivity.synapsesChanged', cb),
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
