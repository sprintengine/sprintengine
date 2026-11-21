import type { StudioExtensionApproval } from '../../../packages/studio-protocol/src/public'
import type { ExtensionApprovalStanding } from './module-signature'

/** An extension's approval as the protocol says it. */
export function approvalView(approval: ExtensionApprovalStanding): StudioExtensionApproval {
  switch (approval.state) {
    case 'pending':
      return {
        state: 'pending',
        fingerprint: approval.fingerprint,
        ...(approval.reapproval ? { growth: [...approval.growth] } : {}),
      }
    case 'approved':
      return { state: 'approved', fingerprint: approval.fingerprint }
    default:
      return { state: approval.state }
  }
}
