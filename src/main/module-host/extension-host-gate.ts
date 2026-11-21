// The gate every call an extension makes into Studio passes. Pure, and the
// same for every way a call arrives: the extension's worker calling a service
// or a `MainHost` method in process, and its window half calling a host
// service over the Studio protocol.
//
// A call goes through only when all of these hold, checked in this order:
//
// 1. The method is one the table knows (`EXTENSION_HOST_SERVICES`,
//    `EXTENSION_MAIN_HOST_METHODS`): deny by default.
// 2. The extension is approved as it is now. One that is not, or is no longer
//    installed or switched on, is refused `approval_required` alike, so a
//    caller cannot tell them apart.
// 3. Its approved grant holds the permission the method needs of it.
// 4. Whoever invoked it (extension-invocation.ts) holds what the method needs
//    of an invoker, or is the person themselves for an `owner` method.
//
// 3 and 4 are both `not_permitted`, with words that say which side lacked what.

import {
  EXTENSION_HOST_REFUSALS,
  type ExtensionHostRefusalCode,
  type ExtensionHostRequirement,
} from '../../../packages/extension-sdk/src/services'
import type { StudioPermission } from '../../../packages/studio-protocol/src/permissions'
import type { ExtensionInvoker } from './extension-invocation'

export type ExtensionHostDecision = { ok: true } | { ok: false; code: ExtensionHostRefusalCode; message: string }

export type ExtensionHostCall = {
  extensionId: string
  /** The method's name, for the refusal's words. */
  method: string
  /** Its row in the table; undefined for a method the table does not hold. */
  requirement: ExtensionHostRequirement | undefined
  /** The permissions the extension's approval holds now; null when it is not approved now. */
  grant: readonly string[] | null
  invoker: ExtensionInvoker
}

export function gateExtensionHostCall(call: ExtensionHostCall): ExtensionHostDecision {
  const { extensionId, method, requirement, grant, invoker } = call
  if (!requirement)
    return {
      ok: false,
      code: EXTENSION_HOST_REFUSALS.notPermitted,
      message: `"${method}" is not a host method an extension may call.`,
    }
  if (grant === null)
    return {
      ok: false,
      code: EXTENSION_HOST_REFUSALS.approvalRequired,
      message: `Extension "${extensionId}" is not approved as it is now, so Studio refused "${method}". Approve it in Settings → Extensions.`,
    }
  if (requirement.extension !== null && !grant.includes(requirement.extension))
    return {
      ok: false,
      code: EXTENSION_HOST_REFUSALS.notPermitted,
      message: `Extension "${extensionId}" was not approved for "${requirement.extension}", which "${method}" needs.`,
    }
  const needed = requirement.invoker
  if (needed === 'owner' && !invoker.principal.owner)
    return {
      ok: false,
      code: EXTENSION_HOST_REFUSALS.notPermitted,
      message: `"${method}" acts with the sign-in of the person at this machine, so only they can set it off; ${invoker.label} cannot.`,
    }
  if (needed !== null && needed !== 'owner' && !invoker.principal.permissions.has(needed as StudioPermission))
    return {
      ok: false,
      code: EXTENSION_HOST_REFUSALS.notPermitted,
      message: `"${method}" of extension "${extensionId}" needs "${needed}", which ${invoker.label} does not hold.`,
    }
  return { ok: true }
}

/** A refused host call, for a method that has no failure shape to answer with. */
export class ExtensionHostRefusal extends Error {
  readonly code: ExtensionHostRefusalCode
  constructor(code: ExtensionHostRefusalCode, message: string) {
    super(message)
    this.name = 'ExtensionHostRefusal'
    this.code = code
  }
}

/**
 * How a refused call is told, as its row says: the method's own failure
 * shape, as a settled promise, or a throw.
 */
export function refuseExtensionHostCall(
  requirement: ExtensionHostRequirement | undefined,
  refusal: Extract<ExtensionHostDecision, { ok: false }>,
): Promise<{ ok: false; code: ExtensionHostRefusalCode; message: string }> {
  if (requirement?.refusal === 'answer')
    return Promise.resolve({ ok: false, code: refusal.code, message: refusal.message })
  throw new ExtensionHostRefusal(refusal.code, refusal.message)
}
