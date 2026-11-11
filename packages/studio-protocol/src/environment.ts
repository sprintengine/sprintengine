import type { StudioEnvironment, StudioWelcomeFrame } from './envelope.js'

// Environments: one way to name a Studio and a chat in it.
//
// Every Studio server (a desktop, a server inside a WSL distribution, one on
// an SSH machine, a paired desktop) is an environment. It mints its id once
// per data directory and says it in its handshake (`welcome.environment.id`),
// so a client that reaches one Studio by two routes recognises it as one, and
// a machine renamed or reached another way keeps its chats.
//
// A client keeps, per environment, the routes it can reach it by, best first;
// and it names a chat by the environment that holds it and the chat's id
// there. A route says how to get somewhere; an address says what. Nothing here
// opens a connection.

/** A Studio's stable id: minted once per data directory. */
export type EnvironmentId = string

const ID = /^[A-Za-z0-9_-]{1,128}$/u

/**
 * Whether a value can be an environment id: 1 to 128 characters of
 * `[A-Za-z0-9_-]`. Every Studio mints a UUID; the wider set is what an
 * address can carry without escaping. No colon, so an address key splits on
 * its one colon.
 */
export function isEnvironmentId(value: unknown): value is EnvironmentId {
  return typeof value === 'string' && ID.test(value)
}

/** What a Studio says it runs as: a desktop's own (`local`), inside WSL, or on an SSH machine. */
export type EnvironmentKind = StudioEnvironment['hostKind']

/**
 * What a client knows about an environment: who it is, what it is called,
 * and what its server speaks. Everything but the name comes from the
 * server's handshake; the name is the client's (what the person called the
 * machine), since a server's own host name means nothing to them.
 */
export type EnvironmentDescriptor = {
  environmentId: EnvironmentId
  kind: EnvironmentKind
  displayName: string
  serverVersion: string
  protocolVersion: number
  minProtocolVersion: number
  /** The Studio capabilities it serves (`STUDIO_CAPABILITIES`), in its own words. */
  capabilities: string[]
}

/** The descriptor a `welcome` (or a `server.info` answer) describes, under the name the client gives it. */
export function environmentDescriptorOf(
  welcome: Pick<
    StudioWelcomeFrame,
    'environment' | 'server' | 'protocolVersion' | 'minProtocolVersion' | 'capabilities'
  >,
  displayName: string,
): EnvironmentDescriptor {
  return {
    environmentId: welcome.environment.id,
    kind: welcome.environment.hostKind,
    displayName,
    serverVersion: welcome.server.version,
    protocolVersion: welcome.protocolVersion,
    minProtocolVersion: welcome.minProtocolVersion,
    capabilities: [...welcome.capabilities],
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * One way to reach an environment, as a client names it:
 *
 *   - `local`: this machine's own Studio.
 *   - `wsl:<distro>`: the server inside a WSL distribution of this PC, by the
 *     distribution's name (what `wsl.exe -d` takes).
 *   - `ssh:<machine>`: the server on an SSH machine the client saved, by the
 *     id it saved it under (stable when its label or address is edited).
 *   - `tailnet:<connection>`: a desktop paired over the tailnet, by the id of
 *     the pairing (stable when the machine is renamed).
 */
export type EnvironmentRoute =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string }
  | { kind: 'ssh'; machine: string }
  | { kind: 'tailnet'; connection: string }

export type EnvironmentRouteKind = EnvironmentRoute['kind']

/**
 * The route kinds, best first: this machine; a server on this PC over
 * loopback; a direct socket over the tailnet; then an SSH tunnel, which costs
 * a session and a forward. The order decides which of an environment's
 * routes a client tries first.
 */
export const ENVIRONMENT_ROUTE_KINDS = [
  'local',
  'wsl',
  'tailnet',
  'ssh',
] as const satisfies readonly EnvironmentRouteKind[]

// The names WSL accepts for a distribution: letters, digits, `.`, `_` and `-`.
const DISTRO = /^[A-Za-z0-9._-]{1,128}$/u
// A saved SSH machine's id and a pairing's id: what the app mints.
const KEY = /^[A-Za-z0-9_-]{1,128}$/u

function routeOk(route: EnvironmentRoute): boolean {
  switch (route.kind) {
    case 'local':
      return true
    case 'wsl':
      return DISTRO.test(route.distro)
    case 'ssh':
      return KEY.test(route.machine)
    case 'tailnet':
      return KEY.test(route.connection)
  }
}

/** A route as one string: `local`, `wsl:Ubuntu`, `ssh:<id>`, `tailnet:<id>`. Throws on a route no parse would give. */
export function formatEnvironmentRoute(route: EnvironmentRoute): string {
  if (!routeOk(route)) throw new Error(`Not an environment route: ${JSON.stringify(route)}`)
  switch (route.kind) {
    case 'local':
      return 'local'
    case 'wsl':
      return `wsl:${route.distro}`
    case 'ssh':
      return `ssh:${route.machine}`
    case 'tailnet':
      return `tailnet:${route.connection}`
  }
}

/** The route a string names, or null for anything `formatEnvironmentRoute` would not have written. */
export function parseEnvironmentRoute(value: unknown): EnvironmentRoute | null {
  if (typeof value !== 'string') return null
  if (value === 'local') return { kind: 'local' }
  const colon = value.indexOf(':')
  if (colon < 0) return null
  const rest = value.slice(colon + 1)
  let route: EnvironmentRoute
  switch (value.slice(0, colon)) {
    case 'wsl':
      route = { kind: 'wsl', distro: rest }
      break
    case 'ssh':
      route = { kind: 'ssh', machine: rest }
      break
    case 'tailnet':
      route = { kind: 'tailnet', connection: rest }
      break
    default:
      return null
  }
  return routeOk(route) ? route : null
}

/** Whether two routes are the same way in. */
export function sameEnvironmentRoute(a: EnvironmentRoute, b: EnvironmentRoute): boolean {
  return routeKey(a) === routeKey(b)
}

function routeKey(route: EnvironmentRoute): string {
  switch (route.kind) {
    case 'local':
      return 'local'
    case 'wsl':
      return `wsl:${route.distro}`
    case 'ssh':
      return `ssh:${route.machine}`
    case 'tailnet':
      return `tailnet:${route.connection}`
  }
}

/** Orders routes best first (`ENVIRONMENT_ROUTE_KINDS`); two of one kind keep the order they came in. */
export function compareEnvironmentRoutes(a: EnvironmentRoute, b: EnvironmentRoute): number {
  return ENVIRONMENT_ROUTE_KINDS.indexOf(a.kind) - ENVIRONMENT_ROUTE_KINDS.indexOf(b.kind)
}

/** The routes best first, each once (the first of a duplicate kept), never sorting the input in place. */
export function orderEnvironmentRoutes(routes: readonly EnvironmentRoute[]): EnvironmentRoute[] {
  const seen = new Set<string>()
  const unique: EnvironmentRoute[] = []
  for (const route of routes) {
    const key = routeKey(route)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(route)
  }
  // Array.prototype.sort is stable, so routes of one kind keep their order.
  return unique.sort(compareEnvironmentRoutes)
}

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * A chat, wherever it is: the environment that holds it and its id there.
 * In Studio a chat is a workspace record, so `chatId` is that record's id,
 * the one a conversation key calls `workspaceId`.
 */
export type ChatAddress = { environmentId: EnvironmentId; chatId: string }

/** One agent's conversation in a chat, wherever it is. */
export type ConversationAddress = ChatAddress & { agentId: string }

// The ids a chat or an agent is minted with (nanoid, the registry's hex,
// `agent-<cli>-<suffix>`): no colon, so an address key has exactly one.
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/u

/** Whether a value is a chat address with ids an address key can carry. */
export function isChatAddress(value: unknown): value is ChatAddress {
  if (value === null || typeof value !== 'object') return false
  const address = value as Record<string, unknown>
  return isEnvironmentId(address.environmentId) && typeof address.chatId === 'string' && CHAT_ID.test(address.chatId)
}

/** A chat address as one string, `<environmentId>:<chatId>`, for a map key or a stored reference. */
export function formatChatAddress(address: ChatAddress): string {
  if (!isChatAddress(address)) throw new Error(`Not a chat address: ${JSON.stringify(address)}`)
  return `${address.environmentId}:${address.chatId}`
}

/** The chat address a `formatChatAddress` string names, or null. */
export function parseChatAddress(value: unknown): ChatAddress | null {
  if (typeof value !== 'string') return null
  const colon = value.indexOf(':')
  if (colon < 0) return null
  const address = { environmentId: value.slice(0, colon), chatId: value.slice(colon + 1) }
  return isChatAddress(address) ? address : null
}

/** Whether two addresses name the same chat. */
export function sameChatAddress(a: ChatAddress, b: ChatAddress): boolean {
  return a.environmentId === b.environmentId && a.chatId === b.chatId
}
