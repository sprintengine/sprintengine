import type { StudioBacklogItemStatus } from './backlog.js'

// The shapes the Backlog and token-usage services answer an extension in:
// its worker (`getBacklogService`, `getUsageService`) and its frames
// (`backlog.*`, `usage.query` through `extension.call`) read the same ones.

/** A Backlog item's status, as the Backlog writes it. */
export type StudioModuleBacklogStatus = StudioBacklogItemStatus

/** Why a Backlog service call was refused, in the service's own words. */
export type StudioModuleBacklogErrorCode =
  | 'not_permitted'
  | 'approval_required'
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

export type StudioModuleUsageErrorCode = 'not_permitted' | 'approval_required' | 'invalid_input' | 'unavailable'

/** The usage service's answer: its rows, or its own refusal. */
export type StudioModuleUsageAnswer =
  | ({ ok: true } & { rows: StudioModuleUsageRow[]; scannedAt: number | null; sources: StudioModuleUsageSource[] })
  | { ok: false; code: StudioModuleUsageErrorCode; message: string }
