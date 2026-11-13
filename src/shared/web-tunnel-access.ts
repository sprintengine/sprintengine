import {
  authorizeStudioAccess,
  studioAccessFor,
  studioPrincipal,
  type StudioAccess,
  type StudioPermission,
  type StudioPrincipal,
} from '../../packages/studio-protocol/src/permissions'
import type { ServerIpcChannelName } from './ipc-channel-owners'
import {
  WEB_BROWSE_FOLDERS_CHANNEL,
  WEB_PREVIEWS_CLOSE_CHANNEL,
  WEB_PREVIEWS_LIST_CHANNEL,
  WEB_PREVIEWS_OPEN_CHANNEL,
  type WebTunnelChannelName,
} from './web-client'

// What a browser tab may reach over its tunnel (phase 9 spec, 14.8), channel
// by channel, in the permissions every remote method declares
// (packages/studio-protocol/src/permissions.ts).
//
// The tunnel is an owner's: a tab of a browser the owner paired drives the
// domains the web client draws, and nothing that acts beyond this server.
// Chats on paired machines, and setting or clearing provider keys or the
// GitHub token stay with the desktop app; their reads that the web client
// shows (whether a key is set) do not. Who may reach this Studio otherwise is
// the Studio protocol's, which says who reaches each: the agents' gateway, its
// HTTP tokens and the paired local apps (`access.ts`), the browsers paired with
// the web listener (`web-devices.ts`), and the tailnet and pairing with another
// machine (`tailnet.ts`).
//
// Typed over every channel the server owns and the front door's own, so a
// channel added to either does not compile until it says here what it needs
// or that it is the desktop app's alone. A name in neither table is refused.
// The renderer routes only the channels this allows to the tunnel, and the
// server refuses any other there (`web-tunnel-guard.ts`), so the rule is held
// on both sides from this one table.

// A browser tab's tunnel carries the desktop's IPC, which only an owner's tab
// reaches: what it is in the protocol's terms is said there.
const TUNNEL_OWNER = "A browser tab reaches this desktop's own channels only under the owner's session."
const owner = (...permissions: StudioPermission[]): StudioAccess => ({ permissions, owner: TUNNEL_OWNER })

export const WEB_TUNNEL_ACCESS: { readonly [C in ServerIpcChannelName | WebTunnelChannelName]: StudioAccess } = {
  'hosts:home': owner('workspace:read'),
  'hosts:list': owner('workspace:read'),
  // The front door's own channels.
  [WEB_BROWSE_FOLDERS_CHANNEL]: owner('filesystem:read'),
  [WEB_PREVIEWS_LIST_CHANNEL]: owner('workspace:read'),
  [WEB_PREVIEWS_OPEN_CHANNEL]: owner('preview:operate'),
  [WEB_PREVIEWS_CLOSE_CHANNEL]: owner('preview:operate'),
  // An embed lets another page frame a conversation: it is access to this machine.
}

/**
 * The front door's HTTP routes beside the tunnel that a session opens, judged
 * by the same principal: staging a picture or a file for a message the
 * owner's composer will send.
 */
export const WEB_HTTP_ACCESS = {
  upload: owner('conversation:read', 'conversation:operate'),
} as const satisfies Readonly<Record<string, StudioAccess>>

/**
 * What an owner's browser holds on its tunnel: the permissions the channels
 * and HTTP routes above name, listed rather than derived, so a channel that comes to need one
 * no tab held before is refused until it is given here on purpose. No
 * terminal, no upkeep of this machine, and no tools of its own.
 */
export const WEB_OWNER_TUNNEL_PERMISSIONS: readonly StudioPermission[] = [
  // The upload route's (`WEB_HTTP_ACCESS`): a dropped file for a chat.
  'conversation:read',
  'conversation:operate',
  'workspace:read',
  'filesystem:read',
  'preview:operate',
]

/** The principal a browser is on its tunnel: an owner's holds the list above; anyone else's, nothing. */
export function webTunnelPrincipal(session: { owner: boolean }): StudioPrincipal {
  return studioPrincipal({ owner: session.owner, permissions: session.owner ? WEB_OWNER_TUNNEL_PERMISSIONS : [] })
}

const OWNER_TAB = webTunnelPrincipal({ owner: true })

/** Whether an owner's web tab may use a tunnel channel: what the renderer routes there. */
export function webTunnelAllows(channel: string): boolean {
  return webTunnelAuthorizes(OWNER_TAB, channel)
}

/** Whether a browser may use a tunnel channel: the one decision, from the table above. */
export function webTunnelAuthorizes(principal: StudioPrincipal, channel: string): boolean {
  return authorizeStudioAccess(principal, studioAccessFor(WEB_TUNNEL_ACCESS, channel)).ok
}
