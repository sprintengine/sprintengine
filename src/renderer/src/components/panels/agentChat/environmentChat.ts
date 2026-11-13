import { useSyncExternalStore } from 'react'

import type { StudioClient } from '../../../../../../packages/client-runtime/src/public'
import { formatEnvironmentRoute } from '../../../../../../packages/studio-protocol/src/environment'
import { environmentChatSourceFor, type EnvironmentChatSource } from '../../../studio/environmentChats'
import type { EnvironmentTarget } from '../../../studio/environmentStudio'
import { routeStudioClient } from '../../../../../shared/machine-studio-client'
import type { WorkspaceEnvironmentRef } from '../../../types/workspace'
import {
  localConversationTransport,
  studioConversationTransport,
  type ConversationTransport,
} from './conversationTransport'
import { machineRouteOfPath } from '../../../../../shared/machine-spelling'
import { createStudioChatServices, createStudioConversationParts } from './studioChat'

// A chat that another environment's Studio holds, as this window's chat view
// follows and drives it: the same Studio transport the window's own chats
// use, over this window's client of that environment (`environmentStudio.ts`,
// shared with its chat source), and that environment's providers, files and
// command lists, since the chat's CLI runs there. What it may do is read off
// that environment's welcome. One transport per route and window.
//
// An SSH machine's or a WSL distribution's chat keeps its folder as this
// computer spells it (`ssh://<id>/…`, `\\wsl.localhost\<distro>\…`, or a
// drive the distribution mounts); its client respells at the edge
// (`machine-studio-client.ts`).

/** The environment a chat's record says it is on, as the route the window reaches it by; null for this machine's. */
export function environmentTargetOf(ref: WorkspaceEnvironmentRef | null | undefined): EnvironmentTarget | null {
  if (!ref) return null
  const route =
    ref.kind === 'wsl'
      ? formatEnvironmentRoute({ kind: 'wsl', distro: ref.id })
      : formatEnvironmentRoute({ kind: 'ssh', machine: ref.id })
  return { route, name: ref.label }
}

/** The client the window's callers read, its paths spelled as this computer spells them on a route that needs it. */
export function windowClientOfRoute(client: StudioClient, route: string): StudioClient {
  return routeStudioClient(client, route)
}

const transports = new Map<string, { source: EnvironmentChatSource; transport: ConversationTransport }>()

/** The chat transport of one environment, made on the first ask and kept with its source. */
export function environmentConversationTransport(target: EnvironmentTarget): ConversationTransport {
  const source = environmentChatSourceFor(target)
  const known = transports.get(target.route)
  if (known && known.source === source) return known.transport
  const client = async () => windowClientOfRoute(await source.client(), target.route)
  const parts = createStudioConversationParts(client)
  const services = createStudioChatServices(client, (listener) => source.watchOpen(listener))
  const transport = studioConversationTransport(() => source.welcome(), {
    label: target.name,
    route: target.route,
    parts: () => parts,
    services,
    unwatchPullRequest: async ({ key, url }) => {
      try {
        await (
          await client()
        ).request('pullRequests.unwatch', {
          conversation: { workspaceId: key.workspaceId, agentId: key.agentId },
          url,
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  transports.set(target.route, { source, transport })
  return transport
}

/**
 * The chat transport for a chat's record: its environment's, or null for a
 * chat this window's own Studio holds. Renders again when that environment
 * welcomes the window again, since what the chat may do is read off it.
 */
export function useEnvironmentConversationTransport(
  ref: WorkspaceEnvironmentRef | null | undefined,
): ConversationTransport | null {
  const target = environmentTargetOf(ref)
  const route = target?.route ?? null
  const source = target ? environmentChatSourceFor(target) : null
  useSyncExternalStore(
    (listener) => (source ? source.watchOpen(listener) : () => undefined),
    () => source?.welcome() ?? null,
    () => source?.welcome() ?? null,
  )
  return target && route ? environmentConversationTransport(target) : null
}

/** The transport of the chat a record names: its environment's, or this window's own Studio's. */
export function conversationTransportOfRecord(ref: WorkspaceEnvironmentRef | null | undefined): ConversationTransport {
  const target = environmentTargetOf(ref)
  return target ? environmentConversationTransport(target) : localConversationTransport
}

/**
 * The transport of the chat a key names, read off its folder alone, for a
 * caller that has no record (an aux window): an SSH machine's chat keeps its
 * folder spelled `ssh://<id>/…` here, a WSL distribution's by its share. (A
 * distribution's chat in a Windows drive folder is told only by its record.)
 */
export function conversationTransportOfKey(key: { workspaceRoot: string }): ConversationTransport {
  const route = machineRouteOfPath(key.workspaceRoot)
  return route
    ? environmentConversationTransport({
        route,
        name: route.startsWith('wsl:') ? `WSL: ${route.slice('wsl:'.length)}` : route.slice('ssh:'.length),
      })
    : localConversationTransport
}
