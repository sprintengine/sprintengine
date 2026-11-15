import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type { McpClientTarget, McpSettings, McpTransport } from './agents.js'
import { STUDIO_AGENT_SETUP_CAPABILITY } from './handshake.js'

// What a Studio's agents are set up with beyond their CLIs: the project
// knowledge graph and the activity agents leave in it (`memory.*`,
// `memoryActivity.*`), the MCP servers written into each CLI's config
// (`mcp.sync`), configuration adopted from a CLI already on the machine
// (`agentConfig.*`), and the skills Studio ships (`builtinSkills.*`,
// `areaSkills.*`). Offered as `agent-setup` where the Studio holds these
// services (a desktop, in process).
//
// Grants. Reading a project's knowledge, its activity and what a skill would
// install is `files:read`, about a folder a client that is not an owner may
// name only inside the ones Studio knows; a folder on an SSH machine is
// refused in words for now. What can run is `providers:read`. Switching
// Studio's own area skills is `settings:write`. What writes the programs and
// hooks the agent CLIs run on this machine (an MCP sync, an adopted
// configuration, the activity hook) is an owner's.
//
// `src/shared` re-exports each type under the name the app has always used.

/** Which agent harness a skill targets. */
export type SkillHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'grok' | 'agents'

// ── Memory ──────────────────────────────────────────────────────────────────

export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

export type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  inboundDegree: number
  group: string
  title?: string
  type?: string
  tags?: string[]
  related?: string[]
}

export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

export type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | Extract<MemoryRootStatus, { ok: false }>

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

export type MemoryActivityEvent = {
  workspaceRoot: string
  sessionId: string
  nodeId: string
  prevNodeId: string | null
  tool: string
  ts: number
  synapseCount: number
}

export type MemoryActivitySynapse = {
  src: string
  dst: string
  count: number
  lastTs: number
}

export type MemoryActivityStatus = {
  workspaceRoot: string | null
  isInstalled: boolean
  isWatching: boolean
  sessionsRecorded: number
  totalEvents: number
  eventsToday: number
  lastEventAt: number | null
}

export type MemoryActivityInstallResult =
  { ok: true; settingsPath: string; hookScriptPath: string } | { ok: false; message: string }

export type MemoryActivityUninstallResult = { ok: true } | { ok: false; message: string }

export type MemoryActivitySynapsesPayload = {
  workspaceRoot: string
  synapses: MemoryActivitySynapse[]
}

// ── MCP ───────────────────────────────────────────────────────────────────

export type McpValidationIssue = {
  level: 'error' | 'warning'
  serverId?: string
  client?: McpClientTarget
  message: string
}

export type McpSyncTarget = {
  client: McpClientTarget
  path: string
  serverIds: string[]
}

export type McpSyncPreview =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncResult =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncInput = {
  workspaceRoot: string
  settings: McpSettings
  clients?: McpClientTarget[]
  /**
   * Servers this sync must take OUT of every CLI's config, named because the
   * settings no longer do. A server is pruned from a config only while
   * `settings` still names it, so a caller that has just forgotten one — an
   * uninstalled plugin's, say — has to say so here or the entry survives in
   * `.mcp.json` for good.
   */
  forgetServerIds?: string[]
  requiredOnly?: boolean
  write?: boolean
  // Connector-scoped writes are exclusive: the worktree config must end with
  // exactly the servers in this sync (the connector set). Any MCP server the
  // base repo committed into the worktree config is pruned rather than merged,
  // preserving the connector-only isolation contract. Off (default) keeps the
  // normal workspace behavior of merging over the user's configured servers.
  pruneUnlistedServers?: boolean
}

// ── Adopting another CLI's configuration ───────────────────────────────────

/**
 * The two CLIs the first-run import wizard scans for existing config. A closed
 * pair, not a list of every CLI: the paths it scans are the *user-level* ones
 * (`~/.codex/config.toml`, `~/.claude.json`), which no plugin manifest declares
 * — manifests declare the workspace paths the writer owns.
 *
 * The parsers behind it are already shared with the manifest-driven read path
 * (src/main/mcp-config-readers), so there is one parser per format. What is
 * still literal here is the path list; widening the wizard to every CLI means
 * declaring those user-level paths in the manifests and resolving them through
 * `resolveMcpConfigPath`, which is the read path's job, not another
 * hardcoded pair here.
 */
export type AgentConfigImportSource = 'codex' | 'claude-code'

export type AgentConfigDetectedMcpServer = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  transport: McpTransport
  enabled: boolean
  envVarNames: string[]
  hasSecretValues: boolean
}

export type AgentConfigDetectedSkill = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  adoptable: boolean
}

export type AgentConfigDetectInput = {
  sources?: AgentConfigImportSource[]
}

export type AgentConfigDetectResult =
  | {
      ok: true
      mcpServers: AgentConfigDetectedMcpServer[]
      skills: AgentConfigDetectedSkill[]
      warnings: string[]
    }
  | { ok: false; message: string; warnings?: string[] }

export type AgentConfigAdoptInput = {
  workspaceRoot: string
  mcpServerKeys?: string[]
  skillKeys?: string[]
}

export type AgentConfigAdoptedMcpServer = {
  id: string
  clients: McpClientTarget[]
}

export type AgentConfigAdoptedSkill = {
  id: string
  status: 'installed' | 'updated'
}

export type AgentConfigAdoptResult =
  | {
      ok: true
      adoptedMcpServers: AgentConfigAdoptedMcpServer[]
      adoptedSkills: AgentConfigAdoptedSkill[]
      warnings: string[]
    }
  | {
      ok: false
      message: string
      adoptedMcpServers?: AgentConfigAdoptedMcpServer[]
      adoptedSkills?: AgentConfigAdoptedSkill[]
      warnings?: string[]
    }

// ── Studio's own skills ────────────────────────────────────────────────────

export type BuiltinSkill = {
  id: string
  name: string
  version: string
  description: string
  harnesses?: SkillHarness[]
  targetPolicy?: 'agents' | 'all-native'
}

export type BuiltinSkillTargetState = {
  harness: string
  destinationPath?: string
  status: 'missing' | 'installed' | 'update-available' | 'modified' | 'local' | 'prompt-shim' | 'unsupported'
  installedVersion?: string
  pluginId?: string
  displayName?: string
  support?: 'native' | 'prompt-shim' | 'unsupported'
  installScope?: 'workspace' | 'user'
  format?: string
  restartRequired?: boolean
}

export type BuiltinSkillStatus =
  | { ok: true; status: 'missing'; skill: BuiltinSkill; destinationPath: string; targets: BuiltinSkillTargetState[] }
  | {
      ok: true
      status: 'installed'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'update-available'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'modified'
      skill: BuiltinSkill
      destinationPath: string
      installedVersion: string
      targets: BuiltinSkillTargetState[]
    }
  | {
      ok: true
      status: 'local'
      skill: BuiltinSkill
      destinationPath: string
      message: string
      targets: BuiltinSkillTargetState[]
    }
  | { ok: false; status: 'unknown-skill' | 'missing-workspace' | 'missing-source'; skillId: string; message: string }

export type StudioAreaSkillId =
  | 'studio-backlog'
  | 'studio-design-system'
  | 'studio-canvas'
  | 'studio-scheduled-agents'
  | 'studio-diff-tours'
  | 'studio-workspaces'
  | 'studio-ship'

/** What the person has decided, per skill. Absent from both lists: never asked. */
export type StudioAreaSkillChoices = {
  enabled: StudioAreaSkillId[]
  /** Suggestions the person turned down; a dismissed skill is still a switch in Settings. */
  dismissed: StudioAreaSkillId[]
}

// ── Methods ─────────────────────────────────────────────────────────────────

type Commanded<T> = { commandId: string } & T

/**
 * A project's knowledge root: the workspace's folder and the root's path
 * inside it. A folder, held to the ones Studio knows for a client that is not
 * an owner, as a file's is; not a workspace's address.
 */
export type MemoryRootParams = { workspaceFolder: string | null; relativeRoot: string | null }

/** Refused `not_found`: a workspace a client that is not an owner may not name. */
export type StudioAgentSetupMethodMap = {
  'memory.resolveRoot': { params: MemoryRootParams; result: MemoryRootStatus; errors: 'not_found' }
  /** Every note and link under the root. */
  'memory.index': { params: MemoryRootParams; result: MemoryGraphIndexResult; errors: 'not_found' }
  'memory.readPreview': {
    params: MemoryRootParams & { relativePath: string }
    result: MemoryPreviewResult
    errors: 'not_found'
  }
  /** Install the hook that records which notes agents read, and start following it. */
  'memoryActivity.install': {
    params: Commanded<{ workspaceFolder: string; memoryRelativeRoot: string }>
    result: MemoryActivityInstallResult
    errors: 'not_found'
  }
  'memoryActivity.uninstall': {
    params: Commanded<{ workspaceFolder: string }>
    result: MemoryActivityUninstallResult
    errors: 'not_found'
  }
  /** Follow an installed hook's log; nothing when there is none. */
  'memoryActivity.startWatching': {
    params: { workspaceFolder: string; memoryRelativeRoot: string }
    result: Record<string, never>
    errors: 'not_found'
  }
  'memoryActivity.status': {
    params: { workspaceFolder: string | null }
    result: MemoryActivityStatus
    errors: 'not_found'
  }
  'memoryActivity.synapses': {
    params: { workspaceFolder: string }
    result: { synapses: MemoryActivitySynapse[] }
    errors: 'not_found'
  }
  'memoryActivity.isInstalled': {
    params: { workspaceFolder: string }
    result: { installed: boolean }
    errors: 'not_found'
  }
  /** Write (or, without `write`, preview) each CLI's MCP config in a workspace. */
  'mcp.sync': { params: Commanded<McpSyncInput>; result: McpSyncResult; errors: 'not_found' }
  /** What another CLI already on this machine is set up with: names only, never a secret's value. */
  'agentConfig.detect': { params: AgentConfigDetectInput; result: AgentConfigDetectResult }
  'agentConfig.adopt': { params: Commanded<AgentConfigAdoptInput>; result: AgentConfigAdoptResult; errors: 'not_found' }
  'builtinSkills.list': { params: Record<string, never>; result: { skills: BuiltinSkill[] } }
  'builtinSkills.status': {
    params: { workspaceFolder: string | null; skillId: string }
    result: BuiltinSkillStatus
    errors: 'not_found'
  }
  'areaSkills.get': { params: Record<string, never>; result: StudioAreaSkillChoices }
  'areaSkills.setEnabled': {
    params: Commanded<{ skillId: StudioAreaSkillId; enabled: boolean }>
    result: StudioAreaSkillChoices
  }
  /** A surface's suggestion turned down; the skill stays a switch in Settings. */
  'areaSkills.dismiss': { params: Commanded<{ skillId: StudioAreaSkillId }>; result: StudioAreaSkillChoices }
}

export type StudioAgentSetupMethod = keyof StudioAgentSetupMethodMap

export type StudioAgentSetupTopicMap = {
  /** Each note an agent moved to, as the hook records it, in every workspace followed. */
  'memoryActivity.events': { params: Record<string, never>; payload: MemoryActivityEvent; stream: 'push' }
  'memoryActivity.statusChanged': { params: Record<string, never>; payload: MemoryActivityStatus; stream: 'push' }
  'memoryActivity.synapsesChanged': {
    params: Record<string, never>
    payload: MemoryActivitySynapsesPayload
    stream: 'push'
  }
  /** The person's area-skill choices, after each change. */
  'areaSkills.changed': { params: Record<string, never>; payload: StudioAreaSkillChoices; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = StudioParamsRefusal
const refuse = (message: string): Refusal => studioParamsRefused(message)

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const STUDIO_AREA_SKILL_IDS: readonly StudioAreaSkillId[] = [
  'studio-backlog',
  'studio-design-system',
  'studio-canvas',
  'studio-scheduled-agents',
  'studio-diff-tours',
  'studio-workspaces',
  'studio-ship',
]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function folder(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}
function relative(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
}
function ids(value: unknown, max = 500): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(id)
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ commandId: value.commandId, ...parsed.params }) : parsed
  }
}

function memoryRoot(value: Record<string, unknown>): StudioParsed<MemoryRootParams> {
  if (value.workspaceFolder !== null && !folder(value.workspaceFolder))
    return refuse('"workspaceFolder" is the workspace\'s folder, or null.')
  if (value.relativeRoot !== null && value.relativeRoot !== undefined && !relative(value.relativeRoot))
    return refuse('"relativeRoot" is a path inside the workspace, or null.')
  return studioParams({
    workspaceFolder: value.workspaceFolder as string | null,
    relativeRoot: (value.relativeRoot ?? null) as string | null,
  })
}

function workspace(value: Record<string, unknown>): StudioParsed<{ workspaceFolder: string }> {
  return folder(value.workspaceFolder)
    ? studioParams({ workspaceFolder: value.workspaceFolder })
    : refuse('"workspaceFolder" is the workspace\'s folder.')
}

/** The workspace an owner's write names, in the shape its service takes. */
function ownersWorkspace(value: Record<string, unknown>): StudioParsed<{ workspaceRoot: string }> {
  return folder(value.workspaceRoot)
    ? studioParams({ workspaceRoot: value.workspaceRoot })
    : refuse('"workspaceRoot" is the workspace\'s folder.')
}

function hook(value: Record<string, unknown>): StudioParsed<{ workspaceFolder: string; memoryRelativeRoot: string }> {
  const at = workspace(value)
  if (!at.ok) return at
  if (!folder(value.memoryRelativeRoot)) return refuse('"memoryRelativeRoot" is the knowledge root inside it.')
  return studioParams({ ...at.params, memoryRelativeRoot: value.memoryRelativeRoot })
}

function areaSkill(value: unknown): value is StudioAreaSkillId {
  return (STUDIO_AREA_SKILL_IDS as readonly unknown[]).includes(value)
}

/** The settings a sync writes, read by the Studio's own normalizer: here, only their shape. */
function mcpSync(value: Record<string, unknown>): StudioParsed<McpSyncInput> {
  const at = ownersWorkspace(value)
  if (!at.ok) return at
  if (!record(value.settings) || !record(value.settings.servers))
    return refuse('"settings" is { syncEnabled, servers }.')
  if (value.clients !== undefined && !ids(value.clients, 50)) return refuse('"clients" is a list of CLI ids.')
  if (value.forgetServerIds !== undefined && !ids(value.forgetServerIds))
    return refuse('"forgetServerIds" is a list of ids.')
  return studioParams({
    workspaceRoot: at.params.workspaceRoot,
    settings: value.settings as McpSettings,
    ...(value.clients === undefined ? {} : { clients: [...(value.clients as string[])] }),
    ...(value.forgetServerIds === undefined ? {} : { forgetServerIds: [...(value.forgetServerIds as string[])] }),
    ...(value.requiredOnly === true ? { requiredOnly: true } : {}),
    ...(value.write === true ? { write: true } : {}),
    ...(value.pruneUnlistedServers === true ? { pruneUnlistedServers: true } : {}),
  })
}

// ── The table ───────────────────────────────────────────────────────────────

const WRITES_AGENT_PROGRAMS =
  'It writes what the agent CLIs on this machine run: their MCP servers, the configuration adopted into them, or a hook.'

const held = (scope: 'files:read' | 'providers:read' | 'settings:write', mutation = false) =>
  ({ scope, mutation, capability: STUDIO_AGENT_SETUP_CAPABILITY }) as const
const owners = (scope: 'files:read' | 'settings:write') =>
  ({ ...held(scope, true), owner: WRITES_AGENT_PROGRAMS }) as const

export const STUDIO_AGENT_SETUP_METHODS: StudioMethodTable<StudioAgentSetupMethodMap> = {
  'memory.resolveRoot': { ...held('files:read'), params: memoryRoot },
  'memory.index': { ...held('files:read'), params: memoryRoot },
  'memory.readPreview': {
    ...held('files:read'),
    params: (value) => {
      const root = memoryRoot(value)
      if (!root.ok) return root
      return relative(value.relativePath) && value.relativePath
        ? studioParams({ ...root.params, relativePath: value.relativePath })
        : refuse('"relativePath" is a note\'s path under the root.')
    },
  },
  'memoryActivity.install': { ...owners('files:read'), params: commanded(hook) },
  'memoryActivity.uninstall': { ...owners('files:read'), params: commanded(workspace) },
  'memoryActivity.startWatching': { ...held('files:read'), params: hook },
  'memoryActivity.status': {
    ...held('files:read'),
    params: (value) =>
      value.workspaceFolder === null || value.workspaceFolder === undefined
        ? studioParams({ workspaceFolder: null })
        : workspace(value),
  },
  'memoryActivity.synapses': { ...held('files:read'), params: workspace },
  'memoryActivity.isInstalled': { ...held('files:read'), params: workspace },
  'mcp.sync': { ...owners('settings:write'), params: commanded(mcpSync) },
  'agentConfig.detect': {
    ...held('providers:read'),
    params: (value) => {
      if (value.sources === undefined) return studioParams({})
      const sources = Array.isArray(value.sources)
        ? value.sources.filter(
            (source): source is AgentConfigImportSource => source === 'codex' || source === 'claude-code',
          )
        : null
      return sources ? studioParams({ sources }) : refuse('"sources" is a list of "codex" and "claude-code".')
    },
  },
  'agentConfig.adopt': {
    ...owners('settings:write'),
    params: commanded((value) => {
      const at = ownersWorkspace(value)
      if (!at.ok) return at
      if (value.mcpServerKeys !== undefined && !ids(value.mcpServerKeys))
        return refuse('"mcpServerKeys" is a list of keys.')
      if (value.skillKeys !== undefined && !ids(value.skillKeys)) return refuse('"skillKeys" is a list of keys.')
      return studioParams({
        workspaceRoot: at.params.workspaceRoot,
        ...(value.mcpServerKeys === undefined ? {} : { mcpServerKeys: [...(value.mcpServerKeys as string[])] }),
        ...(value.skillKeys === undefined ? {} : { skillKeys: [...(value.skillKeys as string[])] }),
      })
    }),
  },
  'builtinSkills.list': { ...held('providers:read'), params: studioNoParams },
  'builtinSkills.status': {
    ...held('files:read'),
    params: (value) => {
      if (value.workspaceFolder !== null && !folder(value.workspaceFolder))
        return refuse('"workspaceFolder" is the workspace\'s folder, or null.')
      if (!id(value.skillId)) return refuse('"skillId" names a built-in skill.')
      return studioParams({ workspaceFolder: value.workspaceFolder as string | null, skillId: value.skillId })
    },
  },
  'areaSkills.get': { ...held('providers:read'), params: studioNoParams },
  'areaSkills.setEnabled': {
    ...held('settings:write', true),
    params: commanded((value) => {
      if (!areaSkill(value.skillId)) return refuse('"skillId" names one of Studio\'s area skills.')
      if (typeof value.enabled !== 'boolean') return refuse('"enabled" is true or false.')
      return studioParams({ skillId: value.skillId, enabled: value.enabled })
    }),
  },
  'areaSkills.dismiss': {
    ...held('settings:write', true),
    params: commanded((value) =>
      areaSkill(value.skillId)
        ? studioParams({ skillId: value.skillId })
        : refuse('"skillId" names one of Studio\'s area skills.'),
    ),
  },
}

const push = (scope: 'files:read' | 'providers:read') =>
  ({ scope, capability: STUDIO_AGENT_SETUP_CAPABILITY, push: true, params: studioNoParams }) as const

export const STUDIO_AGENT_SETUP_TOPICS: StudioTopicTable<StudioAgentSetupTopicMap> = {
  'memoryActivity.events': push('files:read'),
  'memoryActivity.statusChanged': push('files:read'),
  'memoryActivity.synapsesChanged': push('files:read'),
  'areaSkills.changed': push('providers:read'),
}
