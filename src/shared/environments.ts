import {
  formatEnvironmentRoute,
  isEnvironmentRoute,
  type EnvironmentDescriptor,
  type EnvironmentId,
  type EnvironmentRoute,
} from '../../packages/studio-protocol/src/environment'
import type {
  EnvironmentCompatibility,
  EnvironmentConnection,
} from '../../packages/client-runtime/src/environments/environmentStatus'
import type { MachineRef } from './machine-identity'

// The environments this desktop knows, as every window reads them: one list,
// whatever kind of machine each is (design-environments). Main's registry
// (`src/main/environments/environment-registry.ts`) builds it; the window
// reads it over the shell channels below. The saved list of machines is the
// client's own state, like its window geometry, so it is shell IPC, not a
// server method.

// How a connection to an environment stands, and whether it speaks this
// app's protocol, are the client runtime's: the phone reads the same.
export type {
  EnvironmentCompatibility,
  EnvironmentConnection,
  EnvironmentConnectionState,
} from '../../packages/client-runtime/src/environments/environmentStatus'

/** One environment as this desktop knows it. */
export type EnvironmentEntry = {
  /** Null for a machine whose Studio has not answered yet (a distribution whose server never ran). */
  environmentId: EnvironmentId | null
  /** What the person calls it: the name its best route's record gives. */
  displayName: string
  /** The ways in, best first (`orderEnvironmentRoutes`). Never empty. */
  routes: EnvironmentRoute[]
  /** How it is drawn, from its best route's record. */
  machine: MachineRef
  /** What its server said about itself the last time this desktop heard, or null. */
  descriptor: EnvironmentDescriptor | null
  connection: EnvironmentConnection
  compatibility: EnvironmentCompatibility
}

export const UNKNOWN_CONNECTION: EnvironmentConnection = { state: 'unknown', detail: null, lastReachedAt: null }

export const ENVIRONMENT_CHANNELS = {
  /** → `EnvironmentEntry[]`, this machine first. */
  list: 'environments:list',
  /** main → windows, carrying nothing: the list reads differently now. */
  changed: 'environments:changed',
  /** `{ route }` (`formatEnvironmentRoute`) → nothing: ask that route's owner to try it again now. */
  retry: 'environments:retry',
  /** `{ route }` → `EnvironmentTicketResult`: one connection's ticket to that environment's Studio, for this window. */
  ticket: 'environments:ticket',
} as const

/**
 * A window's ticket for one connection to an environment's Studio
 * (design-lane-on-protocol D1): where the socket goes and the credential its
 * hello presents, good once, for thirty seconds, from that window's origin.
 * Main keeps the long-lived credential (a paired desktop's device token) and
 * buys a ticket with it for each connection; the window spends the ticket and
 * keeps nothing. A refusal says why, in the client runtime's codes:
 * `unauthorized` (the pairing is gone there), `outdated` (a Studio from before
 * the protocol), `unavailable` (it did not answer), `unknown_route` (no
 * environment this desktop knows), `unsupported_route` (a kind of route the
 * window does not connect to itself yet).
 */
export type EnvironmentTicketResult =
  { ok: true; url: string; token: string } | { ok: false; code: string; message: string }

/**
 * A key every entry has, for React: the environment's id, or, for one that
 * has not answered yet, its only route.
 */
export function environmentKey(entry: Pick<EnvironmentEntry, 'environmentId' | 'routes'>): string {
  return entry.environmentId ? `id:${entry.environmentId}` : `route:${formatEnvironmentRoute(entry.routes[0]!)}`
}

/**
 * The environment a route reaches, from a list of them. Null, never a throw,
 * for a route no list holds (a pairing id from an old record that no route
 * can carry), since a row's link is read while it draws.
 */
export function environmentOfRoute(
  environments: readonly EnvironmentEntry[],
  route: EnvironmentRoute,
): EnvironmentEntry | null {
  if (!isEnvironmentRoute(route)) return null
  const key = formatEnvironmentRoute(route)
  return (
    environments.find((entry) => entry.routes.some((candidate) => formatEnvironmentRoute(candidate) === key)) ?? null
  )
}

/** The route an environment is reached by, best first, as the bridge names it (`formatEnvironmentRoute`). */
export function environmentRouteOf(entry: Pick<EnvironmentEntry, 'routes'>): string {
  return formatEnvironmentRoute(entry.routes[0]!)
}

/**
 * Whether an environment runs on this computer: this machine, or a WSL
 * distribution it hosts. Its folders are this computer's to browse (a
 * distribution's through its share) and its terminals this computer's.
 */
export function environmentOnThisComputer(entry: Pick<EnvironmentEntry, 'routes'>): boolean {
  const best = entry.routes[0]
  return best?.kind === 'local' || best?.kind === 'wsl'
}

/**
 * The machines a picker lists, in an order that never moves with
 * reachability: this computer and its distributions as the list has them,
 * then every other environment alphabetically, whatever its route.
 */
export function orderEnvironmentsForPicking<T extends Pick<EnvironmentEntry, 'routes' | 'displayName'>>(
  entries: readonly T[],
): T[] {
  const here = entries.filter(environmentOnThisComputer)
  const away = entries
    .filter((entry) => !environmentOnThisComputer(entry))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
  return [...here, ...away]
}
