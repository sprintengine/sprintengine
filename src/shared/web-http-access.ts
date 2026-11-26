import {
  studioPrincipal,
  type StudioAccess,
  type StudioPermission,
  type StudioPrincipal,
} from '../../packages/studio-protocol/src/permissions'

// The web front door's HTTP routes beside the Studio protocol that a
// browser's session reaches, judged in the permissions every remote method
// declares (packages/studio-protocol/src/permissions.ts). What a tab asks of
// its Studio otherwise is the protocol's, which says who reaches each.

const OWNER = "A browser reaches this route only under the owner's session."
const owner = (...permissions: StudioPermission[]): StudioAccess => ({ permissions, owner: OWNER })

/** Staging a picture or a file for a message the owner's composer will send. */
export const WEB_HTTP_ACCESS = {
  upload: owner('conversation:read', 'conversation:operate'),
} as const satisfies Readonly<Record<string, StudioAccess>>

/** What an owner's browser holds on these routes: the permissions they name, listed rather than derived. */
const WEB_OWNER_HTTP_PERMISSIONS: readonly StudioPermission[] = ['conversation:read', 'conversation:operate']

/** The principal a browser is on these routes: an owner's holds the list above; anyone else's, nothing. */
export function webSessionPrincipal(session: { owner: boolean }): StudioPrincipal {
  return studioPrincipal({ owner: session.owner, permissions: session.owner ? WEB_OWNER_HTTP_PERMISSIONS : [] })
}
