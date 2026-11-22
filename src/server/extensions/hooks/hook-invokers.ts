import type { StudioGrant } from '../../../../packages/studio-protocol/src/envelope'
import { studioGrantPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import { nobodyInvoker, ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'

// Who an action a hook guards runs as.
//
// A chat runs as whoever started it, read from the id it was launched under
// (`owner:<command>` for the person's own windows and Studio's own launches,
// `client:<id>:<command>` for a paired device or app, studio-rpc-router.ts),
// and that client is read as it stands now: a device narrowed since holds
// less at once, and one revoked holds nothing. A chat with no launch id was
// started on this machine, by the person or one of their agents.

export type HookInvokers = {
  /** The chat's starter, as an extension's hook runs for it. */
  ofChat(launchCommandId: string | undefined): ExtensionInvoker
  /** Where a client's grant is read from (the Studio RPC's apps and the tailnet's devices). */
  bindClients(grantFor: ((clientId: string) => StudioGrant | null) | null): void
}

export function invokerOfGrant(grant: StudioGrant): ExtensionInvoker {
  return {
    principal: studioGrantPrincipal(grant),
    permissionCeiling: grant.ceiling,
    label: grant.owner ? 'you' : `"${grant.name}"`,
  }
}

export function createHookInvokers(): HookInvokers {
  let grantFor: ((clientId: string) => StudioGrant | null) | null = null
  return {
    ofChat(launchCommandId) {
      if (!launchCommandId || launchCommandId.startsWith('owner:')) return ownerInvoker(null, 'you')
      const client = /^client:([^:]+):/.exec(launchCommandId)?.[1]
      if (!client) return ownerInvoker(null, 'you')
      const grant = grantFor?.(client) ?? null
      return grant ? invokerOfGrant(grant) : nobodyInvoker()
    },
    bindClients(next) {
      grantFor = next
    },
  }
}
