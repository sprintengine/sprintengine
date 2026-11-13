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
  WEB_DEVICES_APPROVE_CHANNEL,
  WEB_DEVICES_DECLINE_CHANNEL,
  WEB_DEVICES_LINK_CHANNEL,
  WEB_DEVICES_RENAME_CHANNEL,
  WEB_DEVICES_REVOKE_CHANNEL,
  WEB_DEVICES_STATUS_CHANNEL,
  WEB_EMBEDS_CREATE_CHANNEL,
  WEB_EMBEDS_LIST_CHANNEL,
  WEB_EMBEDS_REVOKE_CHANNEL,
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
// Pairing other machines, the tailnet's administration, and setting or
// clearing provider keys or the GitHub token stay with the desktop app; their
// reads that the web client shows (whether a key is set) do not. The browsers
// and embeds an owner's tab pairs (`web:devices:*`, `web:embeds:*`) are under
// `access:write`. The agents' gateway, its HTTP tokens and the paired local
// apps are the Studio protocol's (`access.ts`), which says who reaches them.
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
const desktopOnly = (reason: string): StudioAccess => ({ localOnly: reason })

const ACCESS_ADMIN =
  'Who may reach this machine (paired apps, other machines, the tailnet) is administered in the desktop app.'
const WINDOW_STATE = 'Only a desktop window can say it: a tab would report defaults and blanks.'
const BEYOND = 'It acts beyond this server, on another machine or account.'

export const WEB_TUNNEL_ACCESS: { readonly [C in ServerIpcChannelName | WebTunnelChannelName]: StudioAccess } = {
  'hosts:home': owner('workspace:read'),
  'hosts:list': owner('workspace:read'),
  'mesh:cancel-pairing': desktopOnly(BEYOND),
  'mesh:conversation-cancel-side-question': desktopOnly(BEYOND),
  'mesh:conversation-command': desktopOnly(BEYOND),
  'mesh:conversation-context-breakdown': desktopOnly(BEYOND),
  'mesh:conversation-commands': desktopOnly(BEYOND),
  'mesh:conversation-earlier': desktopOnly(BEYOND),
  'mesh:conversation-file-search': desktopOnly(BEYOND),
  'mesh:conversation-follow': desktopOnly(BEYOND),
  'mesh:conversation-list': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-create': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-draft': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-draft-cancel': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-push': desktopOnly(BEYOND),
  'mesh:conversation-pull-request-state': desktopOnly(BEYOND),
  'mesh:conversation-send': desktopOnly(BEYOND),
  'mesh:conversation-side-question': desktopOnly(BEYOND),
  'mesh:conversation-tool-detail': desktopOnly(BEYOND),
  'mesh:conversation-event': desktopOnly(BEYOND),
  'mesh:conversation-tool-image': desktopOnly(BEYOND),
  'mesh:conversation-attachment': desktopOnly(BEYOND),
  'mesh:conversation-turn-diff': desktopOnly(BEYOND),
  'mesh:conversation-watch-changes': desktopOnly(BEYOND),
  'mesh:conversation-changes-diff': desktopOnly(BEYOND),
  'mesh:conversation-changed-file': desktopOnly(BEYOND),
  'mesh:conversation-unfollow': desktopOnly(BEYOND),
  'mesh:forget': desktopOnly(BEYOND),
  'mesh:get-live-state': desktopOnly(BEYOND),
  'mesh:list-connections': desktopOnly(BEYOND),
  'mesh:pair': desktopOnly(BEYOND),
  'mesh:request-pairing': desktopOnly(BEYOND),
  'tailnet:approve-pair-request': desktopOnly(ACCESS_ADMIN),
  'tailnet:cancel-pairing': desktopOnly(ACCESS_ADMIN),
  'tailnet:deny-pair-request': desktopOnly(ACCESS_ADMIN),
  'tailnet:forget-machine': desktopOnly(ACCESS_ADMIN),
  'tailnet:get-live-state': desktopOnly(ACCESS_ADMIN),
  'tailnet:get-status': desktopOnly(ACCESS_ADMIN),
  'tailnet:list-peers': desktopOnly(ACCESS_ADMIN),
  'tailnet:offer-pairing': desktopOnly(ACCESS_ADMIN),
  'tailnet:revoke-device': desktopOnly(ACCESS_ADMIN),
  'tailnet:set-enabled': desktopOnly(ACCESS_ADMIN),
  'tailnet:set-https': desktopOnly(ACCESS_ADMIN),
  'tailnet:reset-mcp-registrations': desktopOnly(ACCESS_ADMIN),
  'tailnet:share-port': desktopOnly(ACCESS_ADMIN),
  'tailnet:share-status': desktopOnly(ACCESS_ADMIN),
  'tailnet:unshare-port': desktopOnly(ACCESS_ADMIN),
  'tailnet:update-device-scopes': desktopOnly(ACCESS_ADMIN),
  'workspace-backup:read': owner('workspace:read'),
  'workspace-backup:write': owner('workspace:operate'),
  'workspace-registry:hydrate': owner('workspace:operate'),
  'workspace-registry:needs-hydration': owner('workspace:read'),
  'workspace-sync:dispatch': owner('workspace:operate'),
  'workspace-sync:get-events-after': owner('workspace:read'),
  'workspace-sync:get-snapshot': owner('workspace:read'),
  'workspace-sync:lifecycle': owner('workspace:operate'),
  'workspace-sync:mark-unread': owner('workspace:operate'),
  'workspace-sync:set-module-run-states': desktopOnly(WINDOW_STATE),
  'workspace-sync:set-settled-chats-settings': desktopOnly(WINDOW_STATE),
  // The front door's own channels.
  [WEB_BROWSE_FOLDERS_CHANNEL]: owner('filesystem:read'),
  [WEB_PREVIEWS_LIST_CHANNEL]: owner('workspace:read'),
  [WEB_PREVIEWS_OPEN_CHANNEL]: owner('preview:operate'),
  [WEB_PREVIEWS_CLOSE_CHANNEL]: owner('preview:operate'),
  // An embed lets another page frame a conversation: it is access to this machine.
  [WEB_EMBEDS_CREATE_CHANNEL]: owner('access:write'),
  [WEB_EMBEDS_LIST_CHANNEL]: owner('access:read'),
  [WEB_EMBEDS_REVOKE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_STATUS_CHANNEL]: owner('access:read'),
  [WEB_DEVICES_REVOKE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_RENAME_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_LINK_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_APPROVE_CHANNEL]: owner('access:write'),
  [WEB_DEVICES_DECLINE_CHANNEL]: owner('access:write'),
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
  'workspace:operate',
  'filesystem:read',
  'preview:operate',
  'access:read',
  'access:write',
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
