import type { StudioClient } from '../../packages/client-runtime/src/public'
import type { StudioCapability } from '../../packages/studio-protocol/src/handshake'
import { formatEnvironmentRoute } from '../../packages/studio-protocol/src/environment'

// The desktop's own client of another environment's Studio, as the callers on
// this computer that act on a chat there ask for it (orchestrator ruling 1,
// design-wsl-ssh-direct PR 1d): the gateway's conversation tools, modules'
// conversation service, the hand-over. Built in main over its owner
// connection (main/environments/environment-client.ts), and in the desktop's
// own server process over a stream main opens for it
// (server/desktop/shell-environment-clients.ts). No server-to-server call, no
// routing table: the route is the chat's record's.

export type EnvironmentClientAnswer =
  { ok: true; client: StudioClient; name: string } | { ok: false; code: string; message: string }

export type EnvironmentClients = {
  /** The client of the environment a route names, connected now if it must be, its paths spelled for this computer. */
  clientFor(route: string, capability?: StudioCapability | null): Promise<EnvironmentClientAnswer>
}

/**
 * The route of the environment a chat's record here says holds it, or null
 * for a chat this desktop's own Studio holds: an SSH machine's chat is that
 * machine's (design-wsl-ssh-direct PR 1d), its record here only a copy.
 */
export function environmentRouteOfRecord(
  record: { environment?: { kind: 'ssh'; id: string } | null } | null | undefined,
): string | null {
  const environment = record?.environment
  return environment?.kind === 'ssh' ? formatEnvironmentRoute({ kind: 'ssh', machine: environment.id }) : null
}
