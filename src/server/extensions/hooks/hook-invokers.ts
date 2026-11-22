import type { StudioGrant } from '../../../../packages/studio-protocol/src/envelope'
import { studioGrantPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import type { AgentStarter } from '../../../shared/agent-state'
import {
  isLooserCliPermissionPreset,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from '../../../shared/cli-permission-preset'
import type { McpConnectionContext } from '../../../main/automation/mcp-socket-server'
import { gatewayCallerStarter, type AgentPermissionResolver } from '../../../main/automation/launch-permission-cap'
import { nobodyInvoker, ownerInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'

// Who an action a hook guards runs as.
//
// An agent's record keeps who started it (`AgentStarter`, set once at launch
// from the connection, the gateway caller or the extension invocation that
// asked, never parsed back out of an id): the person, a paired app or device
// by its client id, or another agent under the ceiling it ran on. A hook on
// that agent's actions runs as them, read as they stand now (a device narrowed
// since holds less at once, and one revoked holds nothing), and never looser
// than the chat's own permission preset, which is the ceiling for what its
// agent does. An agent that says no starter, or one Studio cannot name any
// more, runs its hooks as no one, never as the person.
//
// A gateway caller is who the gateway's own `callerInvoker` says: a paired
// device by its grant, any other (an agent here) as the person under that
// agent's own launch ceiling (`launchPermissionCeiling`).

export type HookInvokers = {
  /** The agent's starter, as a hook on what it does runs: held to the chat's own preset too. */
  ofAgent(agent: { startedBy?: AgentStarter; cliPermissionPreset?: unknown } | undefined): ExtensionInvoker
  /** A paired device or app by its client id (`tailnet:<device>` for a device), as it holds now. */
  ofClient(clientId: string): ExtensionInvoker
  /** Whoever called a gateway tool. */
  ofGatewayCaller(context: McpConnectionContext | undefined): ExtensionInvoker
  /** Where a client's grant is read from (the Studio RPC's apps and the tailnet's devices). */
  bindClients(grantFor: ((clientId: string) => StudioGrant | null) | null): void
}

export function invokerOfGrant(grant: StudioGrant): ExtensionInvoker {
  return {
    principal: studioGrantPrincipal(grant),
    permissionCeiling: grant.ceiling,
    label: grant.owner ? 'you' : `"${grant.name}"`,
    starter: grant.owner ? { kind: 'person' } : { kind: 'client', clientId: grant.clientId },
  }
}

/** The tighter of two ceilings; null is none. */
function tighter(a: CliPermissionPreset | null, b: CliPermissionPreset | null): CliPermissionPreset | null {
  if (a === null) return b
  if (b === null) return a
  return isLooserCliPermissionPreset(a, b) ? b : a
}

export function createHookInvokers(deps: { resolveAgentPermissionPreset: AgentPermissionResolver }): HookInvokers {
  let grantFor: ((clientId: string) => StudioGrant | null) | null = null
  const ofClient = (clientId: string): ExtensionInvoker => {
    const grant = grantFor?.(clientId) ?? null
    return grant ? invokerOfGrant(grant) : nobodyInvoker()
  }
  const ofStarter = (starter: AgentStarter | undefined): ExtensionInvoker => {
    switch (starter?.kind) {
      case 'person':
        return ownerInvoker(null, 'you')
      case 'client':
        return ofClient(starter.clientId)
      case 'agent':
        return ownerInvoker(starter.ceiling, 'the agent that started it', starter)
      default:
        return nobodyInvoker()
    }
  }
  return {
    ofClient,
    ofAgent(agent) {
      const invoker = ofStarter(agent?.startedBy)
      const ceiling = tighter(invoker.permissionCeiling, parseCliPermissionPreset(agent?.cliPermissionPreset) ?? null)
      return ceiling === invoker.permissionCeiling ? invoker : { ...invoker, permissionCeiling: ceiling }
    },
    ofGatewayCaller(context) {
      const starter = gatewayCallerStarter(context, deps.resolveAgentPermissionPreset)
      return starter.kind === 'agent' ? ownerInvoker(starter.ceiling, 'the agent', starter) : ofStarter(starter)
    },
    bindClients(next) {
      grantFor = next
    },
  }
}
