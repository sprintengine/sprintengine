import type { CliPermissionPreset } from './agents.js'
import type { StudioScope } from './scopes.js'

// The shapes of the access family (`access.ts`): the agents' gateway as it
// stands, the tokens its loopback HTTP endpoint admits, and the apps paired
// with the owner socket. `src/shared` re-exports them under the names the app
// has always used.

/** The agents' gateway: the MCP endpoint every Studio-launched agent is given. */
export type AutomationServerStatus = {
  /** Compatibility field; the Studio gateway is always enabled. */
  enabled: boolean
  running: boolean
  /** Unix socket path (POSIX) or named pipe (Windows) while running. */
  socketPath: string | null
  /** Last start/stop failure, surfaced instead of silently staying off. */
  lastError: string | null
  /**
   * Absolute path of the repo/app-shipped stdio bridge script stock MCP
   * clients launch to reach the socket (`node <bridgeScriptPath>`). Static
   * app knowledge, present whether or not the server is running.
   */
  bridgeScriptPath: string | null
}

/** One client the person made a token for. The token itself is shown once, when it is made. */
export type McpHttpClientView = {
  id: string
  name: string
  createdAt: number
  /** When the token last opened a request; null for one never used. */
  lastUsedAt: number | null
}

export type McpHttpStatus = {
  /** Listening: it is while at least one token exists. */
  running: boolean
  /** The endpoint's address while it is listening. */
  url: string | null
  clients: McpHttpClientView[]
  lastError: string | null
}

export type McpHttpCreateResult =
  | {
      ok: true
      status: McpHttpStatus
      client: McpHttpClientView
      /** The bearer token, in the clear this once. */
      token: string
      url: string
    }
  | { ok: false; message: string; status: McpHttpStatus }

/** The longest name a client's token may be given. */
export const MCP_HTTP_CLIENT_NAME_MAX = 60
/** How many tokens may exist at once. */
export const MCP_HTTP_MAX_CLIENTS = 32

/** One paired app. Its token is never part of this: Studio keeps only its hash. */
export type StudioLocalApp = {
  id: string
  /** The name it was paired under, chosen in Settings. */
  name: string
  scopes: StudioScope[]
  /** The loosest permission preset its chats may run on. */
  ceiling: CliPermissionPreset
  createdAt: string
  lastSeenAt: string | null
  /**
   * Which agents the tools it offers reach, when it may offer tools
   * (`tools:offer`): the conversations it starts (`own`), or every
   * conversation and terminal agent on this machine (`all`).
   */
  toolReach: StudioLocalAppToolReach
  /** Whether it has a connection open now. */
  connected: boolean
  /** The toolsets it gives agents, and how each stands now. */
  toolsets: StudioLocalAppToolset[]
}

export type StudioLocalAppToolset = {
  name: string
  title: string
  tools: number
  /** Offered by a connected process, waiting out a reconnect, or not offered now. */
  state: 'offered' | 'reconnecting' | 'not_offered'
}

export type StudioLocalAppToolReach = 'own' | 'all'

/** A pairing code minted and not yet redeemed. The code itself is shown once, when minted. */
export type StudioLocalAppOffer = {
  id: string
  name: string
  scopes: StudioScope[]
  ceiling: CliPermissionPreset
  toolReach: StudioLocalAppToolReach
  expiresAt: string
}

export type StudioLocalAppsStatus = {
  running: boolean
  socketPath: string | null
  lastError: string | null
  apps: StudioLocalApp[]
  offers: StudioLocalAppOffer[]
}

/** What minting a pairing code answers: the code, once, and the status with the offer in it. */
export type StudioLocalAppOfferView = { offer: StudioLocalAppOffer; code: string; status: StudioLocalAppsStatus }

export type StudioLocalAppOfferInput = {
  name: string
  scopes: StudioScope[]
  ceiling: CliPermissionPreset
  toolReach: StudioLocalAppToolReach
}
