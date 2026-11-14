import { useMemo, useSyncExternalStore } from 'react'

import { parseEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import { environmentOfRoute, type EnvironmentEntry } from '../../../shared/environments'
import { environmentChatSourceFor } from '../studio/environmentChats'
import { environmentStudioAvailable } from '../studio/environmentStudio'
import { useEnvironments } from './useEnvironments'

// How this desktop reaches the environment a chat runs in (an SSH machine, a
// WSL distribution, a paired desktop), as the environment list says it: main
// keeps each route's connection, and every window reads the same list. A chat
// view says it in words while that environment is away, as a chat on this
// computer says its window's Studio is away.

export type EnvironmentReach =
  /** Answering. */
  | { kind: 'up'; name: string }
  /** A first connection, or a reconnect, is under way. */
  | { kind: 'connecting'; name: string }
  /** Tried and not answering. */
  | { kind: 'offline'; name: string }
  /** Not connected, and not being tried: stopped, or disconnected by hand. */
  | { kind: 'not-connected'; name: string }
  /** It needs the person to sign in again. */
  | { kind: 'signed-out'; name: string }
  /** The environment list no longer holds the route: the machine was forgotten. */
  | { kind: 'forgotten'; name: string }

/**
 * The reach of the environment a route names, from the environment list.
 * Null for no route (the window's own Studio) and before the list is first
 * read, which always holds this computer: an empty list says nothing yet.
 */
export function environmentReachOf(
  environments: readonly EnvironmentEntry[],
  route: string | null,
  name: string,
): EnvironmentReach | null {
  if (!route || environments.length === 0) return null
  const parsed = parseEnvironmentRoute(route)
  if (!parsed) return null
  const entry = environmentOfRoute(environments, parsed)
  if (!entry) return { kind: 'forgotten', name }
  const called = entry.displayName || name
  switch (entry.connection.state) {
    case 'up':
      return { kind: 'up', name: called }
    case 'connecting':
      return { kind: 'connecting', name: called }
    case 'offline':
      return { kind: 'offline', name: called }
    case 'signed-out':
      return { kind: 'signed-out', name: called }
    case 'unknown':
      return { kind: 'not-connected', name: called }
  }
}

/**
 * What a chat says of its environment while this window's client of it is
 * away (`away`: its chat list is a last read), or null while it answers. The
 * list says why, where it knows: a machine reconnecting, stopped, signing in,
 * forgotten. One the list still calls up is a reconnect of this window's own.
 */
export function environmentReachWords(reach: EnvironmentReach | null, away: boolean, name: string): string | null {
  if (!away) return null
  const called = reach?.name || name
  switch (reach?.kind ?? 'up') {
    case 'up':
    case 'connecting':
      return `Connecting to ${called}… A message you send waits and goes once it answers.`
    case 'offline':
      return `${called} cannot be reached. A message you send waits and goes once it is back.`
    case 'not-connected':
      return `${called} is not connected. A message you send waits until it is connected again in Settings › Machines.`
    case 'signed-out':
      return `${called} turned this computer away. A message you send waits until it is let in again in Settings › Machines.`
    case 'forgotten':
      return `${called} is no longer saved in Settings › Machines, so this chat cannot reach it.`
  }
}

/** The reach of the environment a chat runs in; null for the window's own Studio, or before the list is read. */
export function useEnvironmentReach(route: string | null, name: string | null): EnvironmentReach | null {
  const environments = useEnvironments()
  return useMemo(() => environmentReachOf(environments, route, name ?? ''), [environments, route, name])
}

const noWatch = () => () => undefined

/**
 * Whether this window's client of a chat's environment is away: its chat list
 * there is a last read (`EnvironmentChatsSnapshot.stale`), until the first
 * read lands and while the client reconnects, is parked, or was let go. False
 * for the window's own Studio, and in a page that reaches no environment.
 */
export function useEnvironmentAway(route: string | null, name: string | null): boolean {
  const source = route && environmentStudioAvailable() ? environmentChatSourceFor({ route, name: name ?? route }) : null
  return useSyncExternalStore(
    source ? (listener) => source.subscribe(listener) : noWatch,
    () => source?.snapshot().stale ?? false,
    () => false,
  )
}
