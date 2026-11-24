import React, { useId, type JSX } from 'react'

import type { ThirdPartyModuleView } from '../../../../shared/modules/manifest'
import { extensionApprovalCopy, grantsFullAccess } from '../../../../shared/modules/permissions'
import { AccessCareList, AccessChips, InlineNotice, type AccessItem } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { copy } from '../../../../shared/copy'
import { extensionHookApprovalLines } from '../../../../../packages/extension-sdk/src/hooks'
import { agentContributionLines } from './extensionContributions'
import { AgentContributionList } from './AgentContributionList'

// Review → approve and turn on, in one step. The dialog is the consent: what
// the extension is (its tier, said plainly: a worker's code runs with full
// access to this machine, a ui extension's runs isolated unless it asks to
// change project files, which is full access too), what needs care with a short why for each,
// the rest as quiet pills, and for an update, what it asks beyond what was
// approved before, and what it hands agents and chats: a local MCP server's
// whole command line and environment, a provider's key origin. Approving
// names the fingerprint the person was shown, so a change since is refused
// rather than approved unseen.

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
  const hooks = module.extension.contributes.hooks ?? []
  const hookLines = extensionHookApprovalLines(hooks.map((hook) => hook.point))
  const failsClosed = hooks.some((hook) => hook.onError === 'deny' && !hook.point.endsWith('.after'))
  // Every skill, MCP server and provider it hands agents, the local servers'
  // command lines and the providers' key origins included: what approving lets run.
  const agentLines = agentContributionLines(module.extension, module.ignoredSkillKeys)
  const reach = {
    localServers: agentLines.some((line) => line.kind === 'mcp-local'),
    providers: agentLines.some((line) => line.kind === 'provider'),
  }
  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="standard">
      <ModalHeader
        title={growth ? t.approveAgain(module.manifest.displayName) : t.approve(module.manifest.displayName)}
        titleId={titleId}
        subtitle={meta}
        leading={icon}
      />
      <ModalBody className="space-y-4">
        {module.extension.tier === 'worker' ||
        reach.localServers ||
        (module.extension.tier === 'ui' && grantsFullAccess(module.extension.permissions)) ? (
          <InlineNotice tone="warn">
            {extensionApprovalCopy(module.extension.tier, module.extension.permissions, reach)}
          </InlineNotice>
        ) : (
          <p className="text-body text-[color:var(--text-default)]">
            {extensionApprovalCopy(module.extension.tier, module.extension.permissions, reach)}
          </p>
        )}
        {module.development ? (
          <InlineNotice tone="warn">
            {`A development folder, ${module.development.folder}${module.development.waiting ? '. Approving it replaces the installed extension with its id, which runs until then' : module.development.overrides ? ', in place of the installed extension with its id' : ''}. Studio runs its code as it is on disk and again after every save, so you approve what it may do, not one version of its code. A save that asks for more asks you again.`}
          </InlineNotice>
        ) : null}
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
        {module.extension.contributes.customEditors.length > 0 ? (
          <section aria-label={t.opensFiles}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">{t.opensFiles}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-body text-[color:var(--text-strong)]">
              {module.extension.contributes.customEditors.map((editor) => (
                <li key={editor.id}>
                  {t.editorOpens(editor.title, [...(editor.extensions ?? []), ...(editor.filenames ?? [])].join(', '))}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {hookLines.length > 0 ? (
          <section aria-label={t.hooks}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">{t.hooks}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-body text-[color:var(--text-strong)]">
              {hookLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {failsClosed ? <li>{t.hooksFailClosed}</li> : null}
              {/* Extensions run on this computer's Studio alone: a chat a WSL
                  distribution or an SSH machine runs meets none of its hooks. */}
              <li>{t.hooksThisComputerOnly}</li>
            </ul>
          </section>
        ) : null}
        {agentLines.length > 0 ? (
          <section aria-label={t.forAgents}>
            <h3 className="mb-1.5 text-meta font-semibold text-[color:var(--text-muted)]">{t.forAgents}</h3>
            <AgentContributionList lines={agentLines} label={t.forAgents} />
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
