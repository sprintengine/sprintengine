import type { ConversationCapabilities } from './conversation.js'

// The conversation providers a Studio can run a chat on, as `providers.*`
// answers: the list, a provider's live model catalog, and whether its secret
// is set. Defined here once; the desktop's own windows read the same shapes
// over IPC, and its manifest code re-exports them under the names it has
// always used.

/** Whether a module's code is one Studio may run: its own, signed by a key it trusts, unsigned, or broken. */
export type StudioModuleTrustStatus = 'trusted' | 'signed' | 'unsigned' | 'invalid'

/** A model provider Studio calls itself, or an agent harness (a CLI) that runs the chat. */
export type StudioProviderType = 'model-provider' | 'agent-harness'

export type StudioProviderModel = {
  id: string
  displayName?: string
  /** Max context window in tokens, when the provider reports it: drives the composer's context meter. */
  contextLength?: number
}

export type StudioProviderAdapterKind = 'declarative' | 'trusted-executable'

/** How a provider's adapter runs: as data Studio reads, as code it runs, or not at all. */
export type StudioProviderAdapterClassification = {
  kind: StudioProviderAdapterKind
  execution: 'declarative' | 'executable' | 'blocked'
  trust: StudioModuleTrustStatus | 'not_required'
  entry?: string
  fingerprint?: string
  trustError?: string
}

export type StudioProviderListEntry = {
  capabilities?: ConversationCapabilities
  id: string
  displayName: string
  source: 'bundled' | 'user'
  version: number
  providerType: StudioProviderType
  models: StudioProviderModel[]
  /**
   * The provider exposes a live models endpoint: `models` is then a seed, and
   * the live catalog (`providers.models`) is trusted over it.
   */
  supportsDynamicModels: boolean
  /** Who owns the credential, independent of capabilities or billing. */
  credentialSource: 'native' | 'api-key' | 'none'
  adapter: StudioProviderAdapterClassification
  /**
   * Why the provider cannot start a session now (its CLI was not found). An
   * unavailable provider is listed all the same, never hidden; spawn defaults
   * skip it and a picker shows it disabled with this reason.
   */
  unavailable?: string
}

export type StudioProviderListResult =
  { ok: true; providers: StudioProviderListEntry[] } | { ok: false; message: string }

export type StudioProviderModelsResult = { ok: true; models: StudioProviderModel[] } | { ok: false; message: string }

/** Whether a provider's secret is set, and where from: never the secret itself. */
export type StudioSecretStatus = {
  providerId: string
  configured: boolean
  source: 'settings' | 'session' | 'environment' | 'none'
  persistence: 'encrypted' | 'session' | 'environment'
  encryptionAvailable: boolean
  label: string
}

export type StudioSecretStatusResult = { ok: true; status: StudioSecretStatus } | { ok: false; message: string }
