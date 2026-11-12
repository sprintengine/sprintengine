// Part of the IPC contract: conversation providers and the secrets they and other credentials use.
// ../electron-api.ts re-exports everything here.
import type { StudioSecretStatusResult as ConversationSecretStatusResult } from '../../../packages/studio-protocol/src/public'

// What `providers.*` answers is the Studio protocol's; these are its names here.
export type {
  StudioProviderListResult as ConversationProviderListResult,
  StudioProviderModelsResult as ConversationProviderModelsResult,
  StudioSecretStatus as ConversationSecretStatus,
  StudioSecretStatusResult as ConversationSecretStatusResult,
} from '../../../packages/studio-protocol/src/public'

export type ConversationProviderModelsInput = {
  providerId: string
}

export type ConversationSecretStatusInput = {
  providerId: string
}

export type ConversationSecretSetInput = ConversationSecretStatusInput & {
  value: string
}

export type ConversationSecretClearInput = ConversationSecretStatusInput

export type ConversationSecretSetResult = ConversationSecretStatusResult

export type ConversationSecretClearResult = ConversationSecretStatusResult

// Runtime CLI identity is a plugin id. Bundled choices include `codex` and
// `claude-code`.
export type { AgentCli } from '../../../packages/studio-protocol/src/public'
