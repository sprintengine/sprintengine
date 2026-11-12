import {
  formatEnvironmentRoute,
  type EnvironmentDescriptor,
  type EnvironmentId,
  type EnvironmentRoute,
} from '../../packages/studio-protocol/src/environment'
import type { MachineRef } from './machine-identity'

// The environments this desktop knows, as every window reads them: one list,
// whatever kind of machine each is (design-environments). Main's registry
// (`src/main/environments/environment-registry.ts`) builds it; the window
// reads it over the shell channels below. The saved list of machines is the
// client's own state, like its window geometry, so it is shell IPC, not a
// server method.

/**
 * How this desktop's connection to an environment stands, as the owner of
 * its best route reports it. Today each route's owner reports its own (the
 * SSH machines, the paired desktops' reachability, the WSL distributions);
 * once every machine is a direct environment, its connection supervisor does.
 */
export type EnvironmentConnection = {
  state: EnvironmentConnectionState
  /** The owner's words for the state, when it has better ones than the state's own ("Installing Studio server 0.4.0"). */
  detail: string | null
  /** Epoch ms the machine last answered, when known and it is not answering now. */
  lastReachedAt: number | null
  /** What fixes a `signed-out` machine, in the owner's words ("Pair again", "Sign in"). */
  remedy?: string
}

export type EnvironmentConnectionState =
  /** Answering. */
  | 'up'
  /** A first attempt, or a reconnect, is under way. */
  | 'connecting'
  /** Tried and not answering, or given up on until asked again. */
  | 'offline'
  /** It refused this desktop's credentials: a pairing revoked there, an SSH sign-in needed. */
  | 'signed-out'
  /** Not tried yet: nothing has needed it. */
  | 'unknown'

/**
 * Whether this desktop and the environment's server speak an overlapping
 * protocol window: design-server-update's states. Null until that item
 * records them.
 */
export type EnvironmentCompatibility = 'compatible' | 'client-outdated' | 'server-outdated' | 'unknown'

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
  compatibility: EnvironmentCompatibility | null
}

export const UNKNOWN_CONNECTION: EnvironmentConnection = { state: 'unknown', detail: null, lastReachedAt: null }

export const ENVIRONMENT_CHANNELS = {
  /** → `EnvironmentEntry[]`, this machine first. */
  list: 'environments:list',
  /** main → windows, carrying nothing: the list reads differently now. */
  changed: 'environments:changed',
  /** `{ route }` (`formatEnvironmentRoute`) → nothing: ask that route's owner to try it again now. */
  retry: 'environments:retry',
} as const

/**
 * A key every entry has, for React: the environment's id, or, for one that
 * has not answered yet, its only route.
 */
export function environmentKey(entry: Pick<EnvironmentEntry, 'environmentId' | 'routes'>): string {
  return entry.environmentId ? `id:${entry.environmentId}` : `route:${formatEnvironmentRoute(entry.routes[0]!)}`
}

/** The environment a route reaches, from a list of them. */
export function environmentOfRoute(
  environments: readonly EnvironmentEntry[],
  route: EnvironmentRoute,
): EnvironmentEntry | null {
  const key = formatEnvironmentRoute(route)
  return (
    environments.find((entry) => entry.routes.some((candidate) => formatEnvironmentRoute(candidate) === key)) ?? null
  )
}
