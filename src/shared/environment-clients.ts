import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { StudioCapability } from '../../packages/studio-protocol/src/handshake'
import { formatEnvironmentRoute } from '../../packages/studio-protocol/src/environment'
import { distroOfHostId, workspaceHostIdOf } from './execution-host'

// The desktop's own client of another environment's Studio, as the callers on
// this computer that act on a chat there ask for it (orchestrator ruling 1,
// design-wsl-ssh-direct PR 1d): the gateway's conversation tools, modules'
// conversation service, the hand-over. An SSH machine's is built in main over
// its owner connection (main/environments/environment-client.ts), and in the
// desktop's own server process over a stream main opens for it
// (server/desktop/shell-environment-clients.ts); a WSL distribution's by the
// core that supervises it (server/wsl/wsl-environment-clients.ts). No
// server-to-server call, no routing table: the route is the chat's record's.

export type EnvironmentClientAnswer =
  { ok: true; client: StudioClient; name: string } | { ok: false; code: string; message: string }

export type EnvironmentClients = {
  /** The client of the environment a route names, connected now if it must be, its paths spelled for this computer. */
  clientFor(route: string, capability?: StudioCapability | null): Promise<EnvironmentClientAnswer>
  /** Hear each route whose machine has just connected (a new server connection). Returns the unsubscriber. */
  onConnected(listener: (route: string) => void): () => void
}

/**
 * The route of the environment a chat's record here says holds it, or null
 * for a chat this desktop's own Studio holds. An SSH machine's chat is that
 * machine's (design-wsl-ssh-direct PR 1d), and a WSL distribution's is that
 * distribution's (PR 3c): its record here is only a copy. A WSL workspace this
 * desktop recorded before its distribution held its chats (`hostId`
 * `wsl:<distro>`, or a folder in the distribution with none) is the
 * distribution's all the same, on Windows, the one platform that has any: it
 * waits to be handed over, and nothing here runs it meanwhile.
 */
export function environmentRouteOfRecord(
  record:
    | {
        environment?: { kind: 'ssh' | 'wsl'; id: string } | null
        hostId?: string | null
        folderPath?: string | null
      }
    | null
    | undefined,
  platform: string = process.platform,
): string | null {
  const environment = record?.environment
  if (environment?.kind === 'ssh') return formatEnvironmentRoute({ kind: 'ssh', machine: environment.id })
  if (environment?.kind === 'wsl') return formatEnvironmentRoute({ kind: 'wsl', distro: environment.id })
  const distro = record ? distroOfHostId(workspaceHostIdOf(record), platform) : null
  return distro ? formatEnvironmentRoute({ kind: 'wsl', distro }) : null
}
