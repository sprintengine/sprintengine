import React, { useId, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { extensionApprovalCopy } from '../../../../shared/modules/permissions'
import { AccessCareList, AccessChips, InlineNotice, RefreshIcon, type AccessItem } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { copy } from '../../../../shared/copy'

// Review → approve and turn on, in one step. The dialog is the consent: what
// the extension is (its tier, said plainly: a worker's code runs with full
// access to this machine, a ui extension's runs isolated), what needs care with a short why for each,
// the rest as quiet pills, and for an update, what it asks beyond what was
// approved before. Approving names the fingerprint the person was shown, so a
// change since is refused rather than approved unseen.

export type ApprovalReviewDialogProps = {
  module: ThirdPartyModuleView | null
  /** The extension's mark, as its row draws it. */
  icon: React.ReactNode
  /** "acme · GitHub · v1". */
  meta: string
  care: AccessItem[]
  standard: AccessItem[]
  busy: boolean
  onCancel: () => void
  onApprove: () => void
}

export function ApprovalReviewDialog({
  module,
  icon,
  meta,
  care,
  standard,
  busy,
  onCancel,
  onApprove,
}: ApprovalReviewDialogProps): JSX.Element | null {
  const titleId = useId()
  if (!module) return null
  const approval = module.approval
  const growth = approval.state === 'pending' ? approval.growth : undefined
  const ready = !busy && approval.state === 'pending'
  const t = copy.settings.approvalReviewDialog
  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="standard">
      <ModalHeader
        title={growth ? t.approveAgain(module.manifest.displayName) : t.approve(module.manifest.displayName)}
        titleId={titleId}
        subtitle={meta}
        leading={icon}
      />
      <ModalBody className="space-y-4">
        {module.extension.tier !== 'worker' ? (
          <p className="text-body text-[color:var(--text-default)]">{extensionApprovalCopy('declarative')}</p>
        ) : (
          <InlineNotice tone="warn">{extensionApprovalCopy(module.extension.tier)}</InlineNotice>
        )}
        {growth && growth.length > 0 ? (
          <section aria-label={t.newInThisVersion}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">{t.newInThisVersion}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-body text-[color:var(--text-strong)]">
              {growth.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {care.length > 0 ? (
          <section
            aria-label={t.needsCare}
            className="rounded-md border border-[color:var(--border-default)] px-3 pb-3 pt-2.5"
          >
            <h3 className="mb-2 text-meta font-semibold text-[color:var(--text-muted)]">{t.needsCare}</h3>
            <AccessCareList items={care} ariaLabel={t.needsCare} />
          </section>
        ) : null}
        {standard.length > 0 ? (
          <section aria-label={care.length > 0 ? t.also : t.access}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">
              {care.length > 0 ? t.also : t.access}
            </h3>
            <AccessChips items={standard} ariaLabel={care.length > 0 ? t.also : t.access} />
          </section>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {module.launch.hasMainEntry ? (
          <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <RefreshIcon className="icon-xs shrink-0" />
            {t.startsAfterARestart}
          </span>
        ) : null}
        <ModalButton variant="ghost" onClick={onCancel}>
          {t.cancel}
        </ModalButton>
        <ModalButton variant="primary" disabled={!ready} onClick={onApprove}>
          {t.approveAndTurnOn}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}
