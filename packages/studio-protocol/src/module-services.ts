import {
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParsed,
  type StudioParamsRefusal,
} from './contract.js'
import { STUDIO_MODULES_CAPABILITY } from './handshake.js'
import type { StudioBacklogItemStatus } from './backlog.js'

// The host's services a module's window half calls on its server: the
// Backlog's writes and the token-usage query, the same services its main half
// reaches in process through the module SDK (`getBacklogService`,
// `getUsageService`). Each call names the calling module; the server answers
// `module_unavailable` for one that is not running there, then hands the call
// to the service under that module's id, and the service checks the
// module's own permission (`backlog.read`, `backlog.write`, `usage:read`) as
// it does for the main half. What a service answers, its refusals in its own
// codes included, is the result; the protocol's refusals are the request's
// errors.
//
// Two grants hold every call: the client's (`modules:read` for a read,
// `modules:operate` for a write, which carries it) and the module's own
// manifest permissions. A write is a mutation: it carries the client's
// `commandId` and a retry under it is answered with the first answer.
// Offered under the `modules` capability, where a module kernel runs.

/** A Backlog item's status, as the Backlog writes it. */
export type StudioModuleBacklogStatus = StudioBacklogItemStatus

/** Why a Backlog service call was refused, in the service's own words. */
export type StudioModuleBacklogErrorCode =
  | 'permission_missing'
  | 'invalid_input'
  | 'unknown_workspace'
  | 'workspace_folder_missing'
  | 'not_found'
  | 'backlog_unavailable'

/** A Backlog service's answer: what it did, or its own refusal. */
export type StudioModuleBacklogAnswer<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: StudioModuleBacklogErrorCode; message: string }

/** Where a workspace's Backlog is kept. */
export type StudioModuleBacklogLocation = {
  root: string
  isDefault: boolean
  exists: boolean
}

/** A new Backlog item. The service checks the title, the epic's slug and the lengths. */
export type StudioModuleBacklogCreateInput = {
  title: string
  body?: string
  status?: StudioModuleBacklogStatus
  type?: string
  epic?: string
  difficulty?: string
  criticality?: string
  risk?: string
}

/** The triage fields to set; `null` clears one, an absent one is kept. */
export type StudioModuleBacklogTriageInput = {
  difficulty?: string | null
  criticality?: string | null
  risk?: string | null
}

/** The item a create made. */
export type StudioModuleBacklogCreated = {
  id: string
  relativePath: string
  path: string
  numericId?: number
  displayId?: string
}

export type StudioModuleBacklogLinkType = 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
export type StudioModuleBacklogLinkStatus = 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

/** A link a module records on an item; its `moduleId` is the caller's unless it names another. */
export type StudioModuleBacklogLinkInput = {
  id: string
  moduleId?: string
  type: StudioModuleBacklogLinkType
  label: string
  target: { kind: string; id: string; path?: string; url?: string }
  status?: StudioModuleBacklogLinkStatus
  updatedAt?: string
}

export type StudioModuleUsageGroupBy = 'day' | 'model' | 'workspace' | 'session' | 'provider'

/** A window of token usage to read, and how to group it. */
export type StudioModuleUsageQuery = {
  from: number
  to: number
  groupBy?: StudioModuleUsageGroupBy[]
}

export type StudioModuleUsageTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type StudioModuleUsageRow = {
  day?: string
  model?: string
  providerId?: string
  workspaceId?: string | null
  sessionId?: string
  agentId?: string
  chatTitle?: string | null
  tokens: StudioModuleUsageTokens
  requests: number
  reportedCostUsd: number | null
}

export type StudioModuleUsageSource = {
  id: 'studio' | 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'grok'
  found: number
  error: string | null
}

export type StudioModuleUsageErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

/** The usage service's answer: its rows, or its own refusal. */
export type StudioModuleUsageAnswer =
  | ({ ok: true } & { rows: StudioModuleUsageRow[]; scannedAt: number | null; sources: StudioModuleUsageSource[] })
  | { ok: false; code: StudioModuleUsageErrorCode; message: string }

/** Every call names the module making it. */
type ByModule<P extends object> = { moduleId: string } & P
/** A write carries the client's id for it too. */
type Write<P extends object> = ByModule<P> & { commandId: string }
type OnItem = { workspaceId: string; itemId: string }

export type StudioModuleServicesMethodMap = {
  /** Where a workspace's Backlog is kept. Needs the module's `backlog.read`. */
  'moduleBacklog.location': {
    params: ByModule<{ workspaceId: string }>
    result: StudioModuleBacklogAnswer<{ location: StudioModuleBacklogLocation }>
    errors: 'module_unavailable'
  }
  /** Add an item to a workspace's Backlog. Needs the module's `backlog.write`. */
  'moduleBacklog.create': {
    params: Write<{ workspaceId: string; input: StudioModuleBacklogCreateInput }>
    result: StudioModuleBacklogAnswer<StudioModuleBacklogCreated>
    errors: 'module_unavailable'
  }
  /** Set an item's status. Needs `backlog.write`. */
  'moduleBacklog.updateStatus': {
    params: Write<OnItem & { status: StudioModuleBacklogStatus }>
    result: StudioModuleBacklogAnswer
    errors: 'module_unavailable'
  }
  /** Set or clear an item's triage fields. Needs `backlog.write`. */
  'moduleBacklog.updateTriage': {
    params: Write<OnItem & { triage: StudioModuleBacklogTriageInput }>
    result: StudioModuleBacklogAnswer
    errors: 'module_unavailable'
  }
  /** Record a link on an item, replacing the module's link of the same id. Needs `backlog.write`. */
  'moduleBacklog.addLink': {
    params: Write<OnItem & { link: StudioModuleBacklogLinkInput }>
    result: StudioModuleBacklogAnswer
    errors: 'module_unavailable'
  }
  /** Set the module's own metadata on an item (a JSON value; absent clears it). Needs `backlog.write`. */
  'moduleBacklog.updateModuleMetadata': {
    params: Write<OnItem & { value?: unknown }>
    result: StudioModuleBacklogAnswer
    errors: 'module_unavailable'
  }
  /** Token usage across the agent sessions on the server's machine. Needs the module's `usage:read`. */
  'moduleUsage.query': {
    params: ByModule<{ query: StudioModuleUsageQuery }>
    result: StudioModuleUsageAnswer
    errors: 'module_unavailable'
  }
}

/** The longest id a call may carry: a module's, a workspace's, an item's, a command's. */
const MAX_ID_CHARS = 200
/** The longest text a field may carry here; the service holds a title and a body to its own, smaller limits. */
const MAX_TEXT_CHARS = 512 * 1024

const BACKLOG_STATUSES: ReadonlySet<string> = new Set<StudioModuleBacklogStatus>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
])
const LINK_TYPES: ReadonlySet<string> = new Set<StudioModuleBacklogLinkType>([
  'execution',
  'issue',
  'review',
  'artifact',
  'external',
  'agent',
])
const LINK_STATUSES: ReadonlySet<string> = new Set<StudioModuleBacklogLinkStatus>([
  'pending',
  'active',
  'completed',
  'canceled',
  'failed',
  'unknown',
])
const GROUP_BY: ReadonlySet<string> = new Set<StudioModuleUsageGroupBy>([
  'day',
  'model',
  'workspace',
  'session',
  'provider',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_CHARS
}

/** Copies the optional text fields that are present; the first one that is not text refuses. */
function optionalTexts<K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[],
  nullable: boolean,
  into: Partial<Record<K, string | null>>,
): StudioParamsRefusal | null {
  for (const key of keys) {
    const field = value[key]
    if (field === undefined) continue
    if (nullable && field === null) {
      into[key] = null
      continue
    }
    if (!text(field)) return studioParamsRefused(`"${key}" is text${nullable ? ' or null' : ''} when given.`)
    into[key] = field
  }
  return null
}

function byModule(value: Record<string, unknown>): StudioParsed<{ moduleId: string }> {
  return id(value.moduleId)
    ? studioParams({ moduleId: value.moduleId })
    : studioParamsRefused('"moduleId" is the calling module\'s manifest id.')
}

function inWorkspace(value: Record<string, unknown>): StudioParsed<{ moduleId: string; workspaceId: string }> {
  const named = byModule(value)
  if (!named.ok) return named
  if (!id(value.workspaceId)) return studioParamsRefused('"workspaceId" is the workspace\'s id.')
  return studioParams({ ...named.params, workspaceId: value.workspaceId })
}

function onItem(value: Record<string, unknown>): StudioParsed<{ moduleId: string; commandId: string } & OnItem> {
  const named = inWorkspace(value)
  if (!named.ok) return named
  if (!text(value.itemId) || value.itemId.length === 0) return studioParamsRefused('"itemId" is the item\'s view id.')
  const command = commandId(value)
  if (!command.ok) return command
  return studioParams({ ...named.params, itemId: value.itemId, commandId: command.params })
}

function commandId(value: Record<string, unknown>): StudioParsed<string> {
  return id(value.commandId)
    ? studioParams(value.commandId)
    : studioParamsRefused('"commandId" is the client\'s id for this command.')
}

function createInput(value: unknown): StudioParsed<StudioModuleBacklogCreateInput> {
  if (!record(value)) return studioParamsRefused('"input" is the new item: an object with its "title".')
  if (!text(value.title)) return studioParamsRefused('"input.title" is the item\'s title.')
  const input: StudioModuleBacklogCreateInput = { title: value.title }
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !BACKLOG_STATUSES.has(value.status))
      return studioParamsRefused(`"input.status" is one of ${[...BACKLOG_STATUSES].join(', ')}.`)
    input.status = value.status as StudioModuleBacklogStatus
  }
  const rest: Partial<Record<'body' | 'type' | 'epic' | 'difficulty' | 'criticality' | 'risk', string | null>> = {}
  const refused = optionalTexts(value, ['body', 'type', 'epic', 'difficulty', 'criticality', 'risk'], false, rest)
  if (refused) return refused
  return studioParams({ ...input, ...(rest as Omit<StudioModuleBacklogCreateInput, 'title' | 'status'>) })
}

function triageInput(value: unknown): StudioParsed<StudioModuleBacklogTriageInput> {
  if (!record(value)) return studioParamsRefused('"triage" is an object of the fields to set.')
  const triage: StudioModuleBacklogTriageInput = {}
  const refused = optionalTexts(value, ['difficulty', 'criticality', 'risk'], true, triage)
  return refused ?? studioParams(triage)
}

function linkInput(value: unknown): StudioParsed<StudioModuleBacklogLinkInput> {
  if (!record(value)) return studioParamsRefused('"link" is the link to record.')
  if (!id(value.id)) return studioParamsRefused('"link.id" is the link\'s id.')
  if (typeof value.type !== 'string' || !LINK_TYPES.has(value.type))
    return studioParamsRefused(`"link.type" is one of ${[...LINK_TYPES].join(', ')}.`)
  if (!text(value.label)) return studioParamsRefused('"link.label" is the link\'s label.')
  const target = value.target
  if (!record(target) || !text(target.kind) || !text(target.id))
    return studioParamsRefused('"link.target" names what the link points at: its "kind" and "id".')
  const linkTarget: StudioModuleBacklogLinkInput['target'] = { kind: target.kind, id: target.id }
  const where: Partial<Record<'path' | 'url', string | null>> = {}
  const badTarget = optionalTexts(target, ['path', 'url'], false, where)
  if (badTarget) return studioParamsRefused(`"link.target": ${badTarget.message}`)
  const link: StudioModuleBacklogLinkInput = {
    id: value.id,
    type: value.type as StudioModuleBacklogLinkType,
    label: value.label,
    target: { ...linkTarget, ...(where as { path?: string; url?: string }) },
  }
  if (value.moduleId !== undefined) {
    if (!id(value.moduleId)) return studioParamsRefused('"link.moduleId" is a module id, when given.')
    link.moduleId = value.moduleId
  }
  if (value.status !== undefined) {
    if (typeof value.status !== 'string' || !LINK_STATUSES.has(value.status))
      return studioParamsRefused(`"link.status" is one of ${[...LINK_STATUSES].join(', ')}.`)
    link.status = value.status as StudioModuleBacklogLinkStatus
  }
  if (value.updatedAt !== undefined) {
    if (!text(value.updatedAt)) return studioParamsRefused('"link.updatedAt" is a time, when given.')
    link.updatedAt = value.updatedAt
  }
  return studioParams(link)
}

function usageQuery(value: unknown): StudioParsed<StudioModuleUsageQuery> {
  if (!record(value)) return studioParamsRefused('"query" is the window to read: "from" and "to".')
  if (typeof value.from !== 'number' || !Number.isFinite(value.from))
    return studioParamsRefused('"query.from" is a time in epoch milliseconds.')
  if (typeof value.to !== 'number' || !Number.isFinite(value.to))
    return studioParamsRefused('"query.to" is a time in epoch milliseconds.')
  const query: StudioModuleUsageQuery = { from: value.from, to: value.to }
  if (value.groupBy !== undefined) {
    if (
      !Array.isArray(value.groupBy) ||
      value.groupBy.length > GROUP_BY.size ||
      !value.groupBy.every((dimension) => typeof dimension === 'string' && GROUP_BY.has(dimension))
    )
      return studioParamsRefused(`"query.groupBy" is a list of ${[...GROUP_BY].join(', ')}.`)
    query.groupBy = value.groupBy as StudioModuleUsageGroupBy[]
  }
  return studioParams(query)
}

const read = { scope: 'modules:read', mutation: false, capability: STUDIO_MODULES_CAPABILITY } as const
const write = { scope: 'modules:operate', mutation: true, capability: STUDIO_MODULES_CAPABILITY } as const

export const STUDIO_MODULE_SERVICES_METHODS: StudioMethodTable<StudioModuleServicesMethodMap> = {
  'moduleBacklog.location': { ...read, params: inWorkspace },
  'moduleBacklog.create': {
    ...write,
    params: (value) => {
      const named = inWorkspace(value)
      if (!named.ok) return named
      const input = createInput(value.input)
      if (!input.ok) return input
      const command = commandId(value)
      if (!command.ok) return command
      return studioParams({ ...named.params, input: input.params, commandId: command.params })
    },
  },
  'moduleBacklog.updateStatus': {
    ...write,
    params: (value) => {
      const item = onItem(value)
      if (!item.ok) return item
      if (typeof value.status !== 'string' || !BACKLOG_STATUSES.has(value.status))
        return studioParamsRefused(`"status" is one of ${[...BACKLOG_STATUSES].join(', ')}.`)
      return studioParams({ ...item.params, status: value.status as StudioModuleBacklogStatus })
    },
  },
  'moduleBacklog.updateTriage': {
    ...write,
    params: (value) => {
      const item = onItem(value)
      if (!item.ok) return item
      const triage = triageInput(value.triage)
      if (!triage.ok) return triage
      return studioParams({ ...item.params, triage: triage.params })
    },
  },
  'moduleBacklog.addLink': {
    ...write,
    params: (value) => {
      const item = onItem(value)
      if (!item.ok) return item
      const link = linkInput(value.link)
      if (!link.ok) return link
      return studioParams({ ...item.params, link: link.params })
    },
  },
  'moduleBacklog.updateModuleMetadata': {
    ...write,
    params: (value) => {
      const item = onItem(value)
      if (!item.ok) return item
      return studioParams(value.value === undefined ? item.params : { ...item.params, value: value.value })
    },
  },
  'moduleUsage.query': {
    ...read,
    params: (value) => {
      const named = byModule(value)
      if (!named.ok) return named
      const query = usageQuery(value.query)
      if (!query.ok) return query
      return studioParams({ ...named.params, query: query.params })
    },
  },
}
