// Who set off the extension code that is running now, for the host's checks.
//
// Every way into an extension's code is an invocation, and who invoked it is
// fixed by the transport that carried it, never by the extension:
//
// - the person's own window (an owner connection), or an agent on this
//   machine calling the extension's MCP tool: the person, holding every
//   permission. An agent is still held to its own launch preset: the chats
//   the extension starts for it run no looser than the agent does;
// - a paired device or another app over its Studio connection, or a device
//   calling the extension's MCP tool through the tailnet gateway: what that
//   connection was granted, and its ceiling;
// - nothing (a startup hook, a sidecar, a timer the extension set while it
//   started): the person who approved it.
//
// The kernel runs a method's handler or a tool's handler inside the invoker's
// context, and every host call the extension makes checks the invoker as well
// as the extension's own grant (extension-host-gate.ts). AsyncLocalStorage
// follows the handler's own async work (awaits, timers, promises it starts),
// which is exactly the work done on the invoker's behalf. A listener the
// extension registered before the call runs outside it, as the person's.

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  STUDIO_PERMISSIONS,
  studioPrincipal,
  type StudioPrincipal,
} from '../../../packages/studio-protocol/src/permissions'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import { clampPresetToCeiling } from '../../shared/permission-ceiling'

export type ExtensionInvoker = {
  /** What the invoker holds, and whether it is the person at this machine. */
  principal: StudioPrincipal
  /** The loosest preset an agent started on the invoker's behalf may run on; null when not capped. */
  permissionCeiling: CliPermissionPreset | null
  /** Who it is, for a refusal's words: "this device", "this app", "the agent". */
  label: string
}

/** The person at this machine: every permission, no ceiling. */
export const OWNER_PRINCIPAL: StudioPrincipal = studioPrincipal({ owner: true, permissions: STUDIO_PERMISSIONS })

export function ownerInvoker(permissionCeiling: CliPermissionPreset | null = null, label = 'you'): ExtensionInvoker {
  return { principal: OWNER_PRINCIPAL, permissionCeiling, label }
}

const storage = new AsyncLocalStorage<ExtensionInvoker>()

/** Run extension code on `invoker`'s behalf. */
export function runAsInvoker<T>(invoker: ExtensionInvoker, handler: () => T): T {
  return storage.run(invoker, handler)
}

/** Who invoked the extension code running now; the person when nothing did (its own work). */
export function currentInvoker(): ExtensionInvoker {
  return storage.getStore() ?? ownerInvoker()
}

/**
 * The permission ceiling of whoever invoked the code running now, or null
 * outside an invocation or when its invoker is not capped.
 */
export function invokerCeiling(): CliPermissionPreset | null {
  return storage.getStore()?.permissionCeiling ?? null
}

/**
 * The preset an agent an extension starts during an invocation runs on: the
 * one it asked for, lowered to the invoker's ceiling when looser, and pinned
 * to the ceiling when it asked for none — the launch default could be looser
 * than the invoker. Lowered rather than refused: the extension asked, not the
 * invoker, and it cannot know who invoked it.
 */
export function clampToInvoker(
  requested: CliPermissionPreset | undefined,
  ceiling: CliPermissionPreset | null = invokerCeiling(),
): CliPermissionPreset | undefined {
  return clampPresetToCeiling(requested, ceiling)
}
