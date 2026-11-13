import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_ACCESS_CAPABILITY } from './handshake.js'
import type {
  AutomationServerStatus,
  McpHttpCreateResult,
  McpHttpStatus,
  StudioLocalAppOfferInput,
  StudioLocalAppOfferView,
  StudioLocalAppToolReach,
  StudioLocalAppsStatus,
} from './access-types.js'

// Who may reach this Studio's agents from this machine: the agents' gateway
// as it stands (`gateway.status`), the tokens its loopback HTTP endpoint
// admits (`mcpHttp.*`), and the apps paired with its owner socket
// (`localApps.*`, and the `localApps.changed` stream). Offered as `access`.
//
// Grants. Every method and the stream here is an owner's, and no device
// reaches any of them (tailnet-device-reach.test.ts says so for each).
// Beyond that, two rules:
// - What answers a credential, or lets something new in, is served to
//   Studio's own desktop windows only (`window`): minting an HTTP token, and
//   all of local app pairing (its code admits a process with every scope it
//   names, up to a bypass ceiling). An owner's web tab is refused them, so a
//   stolen browser session cannot mint itself a way in that outlives the
//   session; so is a script holding the owner's credential, so a paired app
//   or an agent cannot pair the next one. The agents' own way to these, the
//   gateway's local-socket tools, asks the person every time.
// - What only reads or narrows reach is an owner's, a web tab included: the
//   gateway's status, the HTTP clients' names and revoking one. None of them
//   carries a token: Studio keeps only each token's hash.

/** Why the gateway's status is an owner's: it names this machine's agent socket and a script on its disk. */
export const STUDIO_GATEWAY_STATUS_OWNER =
  'It names the socket this machine’s agents are served on and the bridge script on its disk.'

/** Why the HTTP endpoint's clients are an owner's. */
export const STUDIO_MCP_HTTP_OWNER =
  'It lists and revokes the clients holding a token to this machine’s agents on its loopback endpoint.'

/** Why minting an HTTP token is Studio's own windows'. */
export const STUDIO_MCP_HTTP_MINT_WINDOW =
  'It mints a bearer token to this machine’s agents and answers it in the clear, so only Studio’s own desktop windows are shown one; a browser session or a paired app cannot mint the next way in.'

/** Why local app pairing is Studio's own windows'. */
export const STUDIO_LOCAL_APPS_WINDOW =
  'It pairs and revokes the apps that reach this machine’s agents through its owner socket: a code it mints admits a process with every scope it names, up to a bypass ceiling, so it is decided at Studio’s own desktop window.'

type Commanded<P> = P & { commandId: string }

export type StudioAccessMethodMap = {
  /** The agents' gateway: whether it is up, its socket, and the bridge script stock MCP clients run. */
  'gateway.status': { params: Record<string, never>; result: AutomationServerStatus }
  /** The loopback HTTP endpoint and the clients holding a token to it; never a token. */
  'mcpHttp.status': { params: Record<string, never>; result: McpHttpStatus }
  /** Mint a token for a client named `name`: answered in the clear this once. */
  'mcpHttp.create': { params: Commanded<{ name: string }>; result: McpHttpCreateResult }
  /** Revoke one client's token; an id it does not hold changes nothing. */
  'mcpHttp.revoke': { params: Commanded<{ id: string }>; result: McpHttpStatus }
  /** The paired apps, the codes waiting to be redeemed (never a code), and the socket. */
  'localApps.status': { params: Record<string, never>; result: StudioLocalAppsStatus }
  /** Mint a one-time pairing code for an app: answered this once. */
  'localApps.offer': { params: Commanded<{ input: StudioLocalAppOfferInput }>; result: StudioLocalAppOfferView }
  /** Withdraw a code not yet redeemed. */
  'localApps.cancelOffer': { params: Commanded<{ id: string }>; result: StudioLocalAppsStatus }
  /** Revoke an app: its token, its connections, its toolsets and the approvals of its tools. */
  'localApps.revoke': { params: Commanded<{ id: string }>; result: StudioLocalAppsStatus }
  /** Which agents an app's tools reach. */
  'localApps.setReach': {
    params: Commanded<{ id: string; reach: StudioLocalAppToolReach }>
    result: StudioLocalAppsStatus
  }
}

export type StudioAccessTopicMap = {
  /** The paired apps, whole, at subscribing and whenever one pairs, connects, leaves or is revoked. */
  'localApps.changed': { params: Record<string, never>; payload: StudioLocalAppsStatus; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const PRESETS: readonly string[] = ['none', 'manual', 'auto', 'bypass']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
function id(value: unknown): value is string {
  return text(value, 200) && value.length > 0
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

const named = (value: Record<string, unknown>): StudioParsed<{ id: string }> =>
  id(value.id) ? studioParams({ id: value.id }) : refuse('"id" names the one to change.')

/** An offer's shape; the store checks each scope and the ceiling against what it pairs. */
function offerInput(value: Record<string, unknown>): StudioParsed<{ input: StudioLocalAppOfferInput }> {
  const input = value.input
  if (!record(input)) return refuse('"input" is the app to pair: { name, scopes, ceiling, toolReach }.')
  if (!text(input.name, 200)) return refuse('"name" is the app’s name.')
  if (!Array.isArray(input.scopes) || input.scopes.length > 64 || !input.scopes.every((scope) => text(scope, 100)))
    return refuse('"scopes" is the list of scopes to grant.')
  if (typeof input.ceiling !== 'string' || !PRESETS.includes(input.ceiling))
    return refuse('"ceiling" is "none", "manual", "auto" or "bypass".')
  if (input.toolReach !== 'own' && input.toolReach !== 'all') return refuse('"toolReach" is "own" or "all".')
  return studioParams({
    input: {
      name: input.name,
      scopes: input.scopes as StudioLocalAppOfferInput['scopes'],
      ceiling: input.ceiling as StudioLocalAppOfferInput['ceiling'],
      toolReach: input.toolReach,
    },
  })
}

function reach(value: Record<string, unknown>): StudioParsed<{ id: string; reach: StudioLocalAppToolReach }> {
  if (!id(value.id)) return refuse('"id" names the app.')
  if (value.reach !== 'own' && value.reach !== 'all') return refuse('"reach" is "own" or "all".')
  return studioParams({ id: value.id, reach: value.reach })
}

// ── The table ───────────────────────────────────────────────────────────────

const owner = (reason: string, mutation: boolean) =>
  ({ scope: 'settings:write', mutation, capability: STUDIO_ACCESS_CAPABILITY, owner: reason }) as const
const ownWindow = (reason: string, mutation: boolean) => ({ ...owner(reason, mutation), window: reason }) as const

export const STUDIO_ACCESS_METHODS: StudioMethodTable<StudioAccessMethodMap> = {
  'gateway.status': { ...owner(STUDIO_GATEWAY_STATUS_OWNER, false), params: studioNoParams },
  'mcpHttp.status': { ...owner(STUDIO_MCP_HTTP_OWNER, false), params: studioNoParams },
  'mcpHttp.create': {
    ...ownWindow(STUDIO_MCP_HTTP_MINT_WINDOW, true),
    params: commanded((value) =>
      text(value.name, 200) ? studioParams({ name: value.name }) : refuse('"name" is the client’s name.'),
    ),
  },
  'mcpHttp.revoke': { ...owner(STUDIO_MCP_HTTP_OWNER, true), params: commanded(named) },
  'localApps.status': { ...ownWindow(STUDIO_LOCAL_APPS_WINDOW, false), params: studioNoParams },
  'localApps.offer': { ...ownWindow(STUDIO_LOCAL_APPS_WINDOW, true), params: commanded(offerInput) },
  'localApps.cancelOffer': { ...ownWindow(STUDIO_LOCAL_APPS_WINDOW, true), params: commanded(named) },
  'localApps.revoke': { ...ownWindow(STUDIO_LOCAL_APPS_WINDOW, true), params: commanded(named) },
  'localApps.setReach': { ...ownWindow(STUDIO_LOCAL_APPS_WINDOW, true), params: commanded(reach) },
}

export const STUDIO_ACCESS_TOPICS: StudioTopicTable<StudioAccessTopicMap> = {
  'localApps.changed': {
    scope: 'settings:write',
    capability: STUDIO_ACCESS_CAPABILITY,
    push: true,
    owner: STUDIO_LOCAL_APPS_WINDOW,
    window: STUDIO_LOCAL_APPS_WINDOW,
    params: studioNoParams,
  },
}
