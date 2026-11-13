import { useSyncExternalStore } from 'react'

import type { StudioClient } from '../../../../../../packages/client-runtime/src/public'
import {
  formatEnvironmentRoute,
  parseEnvironmentRoute,
} from '../../../../../../packages/studio-protocol/src/environment'
import { environmentChatSourceFor, type EnvironmentChatSource } from '../../../studio/environmentChats'
import type { EnvironmentTarget } from '../../../studio/environmentStudio'
import { machineStudioClient } from '../../../studio/machineStudioClient'
import type { WorkspaceEnvironmentRef } from '../../../types/workspace'
import { studioConversationTransport, type ConversationTransport } from './conversationTransport'
import { createStudioChatServices, createStudioConversationParts } from './studioChat'

// A chat that another environment's Studio holds, as this window's chat view
// follows and drives it: the same Studio transport the window's own chats
// use, over this window's client of that environment (`environmentStudio.ts`,
// shared with its chat source), and that environment's providers, files and
// command lists, since the chat's CLI runs there. What it may do is read off
// that environment's welcome. One transport per route and window.
//
// An SSH machine's chat keeps its folder as this computer spells it,
// `ssh://<id>/…`; its client respells at the edge (`machineStudioClient.ts`).

/** The environment a chat's record says it is on, as the route the window reaches it by; null for this machine's. */
export function environmentTargetOf(ref: WorkspaceEnvironmentRef | null | undefined): EnvironmentTarget | null {
  if (!ref) return null
  return { route: formatEnvironmentRoute({ kind: 'ssh', machine: ref.id }), name: ref.label }
}

/** The client the window's callers read, its paths spelled as this computer spells them on a route that needs it. */
export function windowClientOfRoute(client: StudioClient, route: string): StudioClient {
  const parsed = parseEnvironmentRoute(route)
  return parsed?.kind === 'ssh' ? machineStudioClient(client, parsed.machine) : client
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
