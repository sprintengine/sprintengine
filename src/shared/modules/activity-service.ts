// The person's own agent activity as modules read it: token usage across every
// agent session on this machine (permission `usage:read`, served by
// main/usage/usage-service.ts) and their Studio chats and prompts (permission
// `conversation:read-all`, served by main/module-host/module-activity.ts).
// The SDK mirrors these shapes by hand and the drift guard pins the two
// together. Type-only.

import type {
  StudioModuleUsageAnswer,
  StudioModuleUsageErrorCode,
  StudioModuleUsageGroupBy,
  StudioModuleUsageQuery,
  StudioModuleUsageRow,
  StudioModuleUsageSource,
  StudioModuleUsageTokens,
} from '../../../packages/studio-protocol/src/public'
import type { ModuleConversationStatus } from './conversation-service'

// ── Usage ────────────────────────────────────────────────────────────────────

// The wire shapes are the Studio protocol's (`module-services.ts`).
export type UsageGroupBy = StudioModuleUsageGroupBy
export type UsageQuery = StudioModuleUsageQuery
export type UsageTokens = StudioModuleUsageTokens
export type UsageRow = StudioModuleUsageRow
export type UsageSource = StudioModuleUsageSource
export type ModuleUsageErrorCode = StudioModuleUsageErrorCode

export type ModuleUsageResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleUsageErrorCode; message: string }

export type UsageQueryResult = ModuleUsageResult<{
  rows: UsageRow[]
  scannedAt: number | null
  sources: UsageSource[]
}>

// What the protocol carries is what the service answers.
const usageShape: [UsageQueryResult] extends [StudioModuleUsageAnswer]
  ? [StudioModuleUsageAnswer] extends [UsageQueryResult]
    ? true
    : false
  : false = true
void usageShape

export type ModuleUsageService = {
  query(query: UsageQuery): Promise<UsageQueryResult>
  onChanged(listener: () => void): () => void
}

export type ModuleUsageRegistry = {
  [K in keyof ModuleUsageService]: (
    moduleId: string,
    ...args: Parameters<ModuleUsageService[K]>
  ) => ReturnType<ModuleUsageService[K]>
}

// ── Activity ─────────────────────────────────────────────────────────────────

export type ActivityChatSummary = {
  workspaceId: string
  agentId: string
  title: string
  cli: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
  turnCount: number
  status: ModuleConversationStatus | 'absent'
}

export type ActivityListChatsInput = {
  from?: number
  to?: number
  workspaceId?: string
}

export type ActivityPrompt = {
  at: number
  workspaceId: string
  agentId: string
  text: string
  replyTail?: string
}

export type ActivityPromptsInput = {
  from: number
  to: number
  workspaceId?: string
  limit?: number
}

export type ModuleActivityErrorCode = 'permission_missing' | 'invalid_input' | 'unavailable'

export type ModuleActivityResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleActivityErrorCode; message: string }

export type ModuleActivityService = {
  listChats(input?: ActivityListChatsInput): Promise<ModuleActivityResult<{ chats: ActivityChatSummary[] }>>
  prompts(input: ActivityPromptsInput): Promise<ModuleActivityResult<{ prompts: ActivityPrompt[]; truncated: boolean }>>
}

export type ModuleActivityRegistry = {
  [K in keyof ModuleActivityService]: (
    moduleId: string,
    ...args: Parameters<ModuleActivityService[K]>
  ) => ReturnType<ModuleActivityService[K]>
}
