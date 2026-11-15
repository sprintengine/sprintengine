import React, { useEffect, useId, useState, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { AccessCareList, AccessChips, Checkbox, RefreshIcon, type AccessItem } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { copy } from '../../../../shared/copy'

// Review → trust and turn on, in one step. The dialog is the consent: what
// needs care with a short why for each, the rest as quiet pills, and — for
// unsigned code only — one box the person ticks to say they trust it anyway,
// which is what enables the primary action. Nothing explains the dialog to
// itself: no sentence under the box, no reassurance under the title.

export type TrustReviewDialogProps = {
  module: ThirdPartyModuleView | null
  /** The extension's mark, as its row draws it. */
  icon: React.ReactNode
  /** "acme · GitHub · v1". */
  meta: string
  care: AccessItem[]
  standard: AccessItem[]
  busy: boolean
  onCancel: () => void
  onTrust: () => void
}

export function TrustReviewDialog({
  module,
  icon,
  meta,
  care,
  standard,
  busy,
  onCancel,
  onTrust,
}: TrustReviewDialogProps): JSX.Element | null {
  const titleId = useId()
  const [trustUnsigned, setTrustUnsigned] = useState(false)
  // A fresh answer for every module the dialog opens on.
  const moduleId = module?.manifest.id ?? null
  useEffect(() => setTrustUnsigned(false), [moduleId])

  if (!module) return null
  const unsigned = module.trust === 'unsigned'
  const ready = !busy && (!unsigned || trustUnsigned)
  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="standard">
      <ModalHeader
        title={copy.settings.trustReviewDialog.trust(module.manifest.displayName)}
        titleId={titleId}
        subtitle={meta}
        leading={icon}
      />
      <ModalBody className="space-y-4">
        {care.length > 0 ? (
          <section
            aria-label={copy.settings.trustReviewDialog.needsCare}
            className="rounded-md border border-[color:var(--border-default)] px-3 pb-3 pt-2.5"
          >
            <h3 className="mb-2 text-meta font-semibold text-[color:var(--text-muted)]">
              {copy.settings.trustReviewDialog.needsCare}
            </h3>
            <AccessCareList items={care} ariaLabel={copy.settings.trustReviewDialog.needsCare} />
          </section>
        ) : null}
        {standard.length > 0 ? (
          <section
            aria-label={care.length > 0 ? copy.settings.trustReviewDialog.also : copy.settings.trustReviewDialog.access}
          >
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">
              {care.length > 0 ? 'Also' : 'Access'}
            </h3>
            <AccessChips
              items={standard}
              ariaLabel={
                care.length > 0 ? copy.settings.trustReviewDialog.also : copy.settings.trustReviewDialog.access
              }
            />
          </section>
        ) : null}
        {unsigned ? (
          <div className="rounded-md bg-[color:var(--tone-warn-soft)] px-3 py-2.5">
            <Checkbox
              checked={trustUnsigned}
              onChange={setTrustUnsigned}
              size="body"
              label={
                <span className="font-medium text-[color:var(--text-strong)]">
                  {copy.settings.trustReviewDialog.iTrustThisUnsignedCode}
                </span>
              }
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {module.launch.hasMainEntry ? (
          <span className="mr-auto inline-flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <RefreshIcon className="icon-xs shrink-0" />
            {copy.settings.trustReviewDialog.startsAfterARestart}
          </span>
        ) : null}
        <ModalButton variant="ghost" onClick={onCancel}>
          {copy.settings.trustReviewDialog.cancel}
        </ModalButton>
        <ModalButton variant="primary" disabled={!ready} onClick={onTrust}>
          {copy.settings.trustReviewDialog.trustAndTurnOn}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}
