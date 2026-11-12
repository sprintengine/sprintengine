// Today's machine keys, as environment routes and chat addresses.
//
// Before environments, each part of the app named a machine its own way: a
// workspace's `hostId` (`local`, `wsl:<distro>`), the conversation router's
// key (none for this process, a distribution's name, `ssh:<saved id>`), a
// folder spelled on an SSH machine (`ssh://<saved id>/…`), a workspace's SSH
// record, a paired machine's pairing id. Each maps here onto one
// `EnvironmentRoute`, and back where a key has a way back, so a caller can move
// onto routes and addresses on its own, one at a time, and mean exactly what
// the key it replaces meant.
//
// Nothing here decides where a call goes. A route names the MACHINE a chat
// runs on; the router's key names the PROCESS that answers for it. The two
// differ, deliberately, in three cases the router decides at call time:
//
//   - a WSL chat whose distribution's chats are not on its server: the route
//     is `wsl:<distro>`, the router key null (this process starts the CLI in
//     the distribution);
//   - a workspace on an SSH machine while SSH machines are off this session:
//     the route is `ssh:<id>`, and the router answers it here or not at all;
//   - a router asked without the workspace's folder, which does not see an
//     `ssh://` folder the record holds.
//
// So a router key of null maps to `local` meaning "this process", which is
// this machine's route but not always the machine the chat runs on.
//
// Pure and shared: no fs, no electron.

import {
  formatChatAddress,
  isChatAddress,
  isEnvironmentId,
  type ChatAddress,
  type EnvironmentId,
  type EnvironmentRoute,
} from '../../packages/studio-protocol/src/environment'
import { distroOfHostId, executionHostLabel, LOCAL_HOST_ID, wslHostId, workspaceHostIdOf } from './execution-host'
import type { ExecutionHostId, ExecutionHostSettings } from './execution-host'
import { isMachinePath, machinePath, parseMachinePath } from './machine-paths'
import type { MachineRef } from './machine-identity'
import type { SavedSshEnvironment } from './ssh-environments'
import type { MeshConnection } from './tailnet-mesh'

// ── Keys to routes, and back ────────────────────────────────────────────────

/** The route a workspace `hostId` names: this machine, or one of its WSL distributions. */
export function environmentRouteOfHostId(hostId: ExecutionHostId): EnvironmentRoute {
  const distro = distroOfHostId(hostId)
  return distro ? { kind: 'wsl', distro } : { kind: 'local' }
}

/** The `hostId` a route is, for a machine on this computer; null for another computer's. */
export function hostIdOfEnvironmentRoute(route: EnvironmentRoute): ExecutionHostId | null {
  if (route.kind === 'local') return LOCAL_HOST_ID
  if (route.kind === 'wsl') return wslHostId(route.distro)
  return null
}

const SSH_ROUTER_KEY = /^ssh:([A-Za-z0-9_-]+)$/u

/**
 * The route a conversation router key names (`RoutedConversationBackend.routeOf`):
 * null is this process, `ssh:<saved id>` an SSH machine, anything else a WSL
 * distribution by name. Null for a key the router never makes.
 */
export function environmentRouteOfRouterKey(key: string | null): EnvironmentRoute | null {
  if (key === null) return { kind: 'local' }
  const ssh = SSH_ROUTER_KEY.exec(key)
  if (ssh) return { kind: 'ssh', machine: ssh[1]! }
  const distro = distroOfHostId(wslHostId(key))
  return distro ? { kind: 'wsl', distro } : null
}

/** The router key for a machine the router serves (this process, a distribution, an SSH machine). */
export function routerKeyOfEnvironmentRoute(route: Exclude<EnvironmentRoute, { kind: 'tailnet' }>): string | null {
  if (route.kind === 'local') return null
  if (route.kind === 'wsl') return route.distro
  return `ssh:${route.machine}`
}

/** The SSH machine a folder spelled `ssh://<saved id>/…` is on; null for a path on this computer. */
export function environmentRouteOfMachinePath(path: string | null | undefined): EnvironmentRoute | null {
  if (!path || !isMachinePath(path)) return null
  const parsed = parseMachinePath(path)
  return parsed ? { kind: 'ssh', machine: parsed.id } : null
}

/** A plain path on an SSH machine, spelled as this computer spells it (`machinePath`). */
export function machinePathOnEnvironmentRoute(route: Extract<EnvironmentRoute, { kind: 'ssh' }>, path: string): string {
  return machinePath(route.machine, path)
}

/** The route of a workspace's SSH record (`Workspace.environment`). */
export function environmentRouteOfWorkspaceEnvironment(ref: { kind: 'ssh'; id: string }): EnvironmentRoute {
  return { kind: 'ssh', machine: ref.id }
}

/** The route a pairing with another desktop is (`MeshConnection.id`, `remoteOrigin.connectionId`). */
export function environmentRouteOfMeshConnection(connectionId: string): EnvironmentRoute {
  return { kind: 'tailnet', connection: connectionId }
}

/** The pairing a tailnet route is; null for any other route. */
export function meshConnectionIdOfEnvironmentRoute(route: EnvironmentRoute): string | null {
  return route.kind === 'tailnet' ? route.connection : null
}

/** What a sidebar row knows about where its chat is. */
export type WorkspaceMachineFacts = {
  hostId?: string | null
  folderPath?: string | null
  environment?: { kind: 'ssh'; id: string } | null
  remoteOrigin?: { connectionId: string; workspaceId: string } | null
}

/**
 * The machine a workspace's chats run on, as a route: the paired desktop it
 * was born on; else its SSH machine (its record, or a folder spelled on one,
 * as the router reads them); else, on Windows, the machine its `hostId`
 * names, or its folder's distribution (`workspaceHostIdOf`); else this
 * machine. Off Windows a `wsl:` id names nothing (`distroOfHostId`), so the
 * chat runs here, as the router has it.
 */
export function environmentRouteOfWorkspace(workspace: WorkspaceMachineFacts, platform: string): EnvironmentRoute {
  if (workspace.remoteOrigin?.connectionId) return environmentRouteOfMeshConnection(workspace.remoteOrigin.connectionId)
  if (workspace.environment?.kind === 'ssh') return environmentRouteOfWorkspaceEnvironment(workspace.environment)
  const machine = environmentRouteOfMachinePath(workspace.folderPath)
  if (machine) return machine
  if (platform !== 'win32') return { kind: 'local' }
  return environmentRouteOfHostId(workspaceHostIdOf(workspace))
}

// ── Chat addresses ──────────────────────────────────────────────────────────

/**
 * The address of the chat a sidebar row is, as things stand: the Studio that
 * holds its record. That is this desktop for a chat here, in WSL or on an SSH
 * machine (this desktop's core keeps those records and forwards their calls
 * under the same ids), and the paired desktop for a row born there, under that
 * machine's own id for it. Null while the paired desktop's environment id is
 * not known (it has not answered since a build that says it).
 */
export function chatAddressOfWorkspace(
  workspace: { id: string; remoteOrigin?: { connectionId: string; workspaceId: string } | null },
  environments: { local: EnvironmentId; ofRoute(route: EnvironmentRoute): EnvironmentId | null },
): ChatAddress | null {
  const origin = workspace.remoteOrigin
  const address = !origin?.connectionId
    ? { environmentId: environments.local, chatId: workspace.id }
    : {
        environmentId: environments.ofRoute(environmentRouteOfMeshConnection(origin.connectionId)),
        chatId: origin.workspaceId,
      }
  // An id an address cannot carry (a record from an older build) is no address.
  return isChatAddress(address) ? address : null
}

/**
 * The address key of a paired machine's chat, the environment-scoped successor
 * of `remoteChatKey` (`<pairing id>:<chat id>`): the same chat keys the same
 * whichever pairing reaches it. Null while that machine's id is not known.
 */
export function chatAddressKeyOfRemoteChat(
  connectionId: string,
  workspaceId: string,
  ofRoute: (route: EnvironmentRoute) => EnvironmentId | null,
): string | null {
  const address = { environmentId: ofRoute(environmentRouteOfMeshConnection(connectionId)), chatId: workspaceId }
  return isChatAddress(address) ? formatChatAddress(address) : null
}

// ── Today's records as environment sources ──────────────────────────────────

/**
 * A machine a client knows of, from the record that names it today: the
 * route to it, what the person calls it, how it is drawn (`MachineRef`, from
 * which its mark id follows), and the environment id that record already
 * holds, if any. A record read from disk can hold an id no route can carry;
 * the registry skips such a source (`isEnvironmentRoute`) rather than throw.
 */
export type EnvironmentSource = {
  route: EnvironmentRoute
  displayName: string
  machine: MachineRef
  environmentId: EnvironmentId | null
}

/** This machine. */
export function localEnvironmentSource(environmentId: EnvironmentId, platform: string): EnvironmentSource {
  return {
    route: { kind: 'local' },
    displayName: executionHostLabel(LOCAL_HOST_ID, platform),
    machine: { kind: 'local' },
    environmentId,
  }
}

/**
 * The WSL distributions turned on as machines, from the per-machine settings.
 * None off Windows. A distribution's id is its server's, and is learned when
 * that server answers, so these carry none.
 */
export function wslEnvironmentSources(
  hosts: Partial<Record<string, ExecutionHostSettings>>,
  platform: string,
): EnvironmentSource[] {
  const sources: EnvironmentSource[] = []
  for (const [id, settings] of Object.entries(hosts)) {
    const distro = distroOfHostId(id, platform)
    if (!distro || settings?.enabled !== true) continue
    const hostId = wslHostId(distro)
    sources.push({
      route: { kind: 'wsl', distro },
      displayName: executionHostLabel(hostId, platform),
      machine: { kind: 'wsl', hostId },
      environmentId: null,
    })
  }
  return sources
}

/** A saved SSH machine, under its label, with the id its server last reported. */
export function sshEnvironmentSource(
  saved: Pick<SavedSshEnvironment, 'id' | 'label' | 'destination' | 'resolved' | 'environmentId'>,
): EnvironmentSource {
  return {
    route: { kind: 'ssh', machine: saved.id },
    displayName: saved.label,
    // The host and port every device keys its mark by: what its SSH config
    // resolves to, else what was typed (the renderer's `sshMachineRef`).
    machine: saved.resolved
      ? { kind: 'ssh', host: saved.resolved.hostname, port: saved.resolved.port }
      : { kind: 'ssh', host: saved.destination },
    environmentId: isEnvironmentId(saved.environmentId) ? saved.environmentId : null,
  }
}

/** A desktop paired over the tailnet, under its machine name, with the id its identity answer gave. */
export function meshEnvironmentSource(
  connection: Pick<MeshConnection, 'id' | 'machineName' | 'environmentId'>,
): EnvironmentSource {
  return {
    route: environmentRouteOfMeshConnection(connection.id),
    displayName: connection.machineName,
    machine: { kind: 'paired', name: connection.machineName },
    environmentId: isEnvironmentId(connection.environmentId) ? connection.environmentId : null,
  }
}
