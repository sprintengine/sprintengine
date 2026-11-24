import React, { type JSX } from 'react'

import type {
  ExtensionApprovalState,
  ModuleEnablementOverrides,
  ModuleManifestIssue,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import {
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
} from '../../../../shared/modules/permissions'
import { getModuleContributionError } from '../../modules/ModuleContributionBoundary'
import { getExtensionContributionsState as getThirdPartyRendererLoadState } from '../../modules/extension-contributions'
import type { Tone } from '../ui/tokens'
import { Badge, EmptyState, GhostButton, InlineNotice, OutlineButton, SettingCard, type OverflowMenuItem } from '../ui'
import { deriveContributions, moduleDoorIcon } from './extensionContributions'
import {
  CannotApproveTrailing,
  ExtensionDetails,
  ExtensionMark,
  ExtensionRow,
  ExtensionStateLabel,
  InstalledTrailing,
  ReviewTrailing,
} from './ExtensionRow'
import {
  accessItems,
  isApproved,
  isSigned,
  moduleMeta,
  moduleProblem,
  problemText,
  publisherName,
  resolveModuleEnabled,
  runState,
  sourceLabel,
  updateText,
} from './extensionsModel'
import { SettingsSectionTitle } from './SettingsAtoms'
import { copy as appCopy } from '../../../../shared/copy'

// Settings → Extensions: the two groups of extensions a person installed.
// "Needs review" first — the decision they owe is the first thing on the page —
// then "Installed", the trusted ones with their one switch. The rows and the
// details are in ExtensionRow; what talks to main is in useThirdPartyExtensions.

type ApprovalPresentation = { tone: Tone; label: string }

// The approval state in words, for the Plugins door's installed inventory.
export const APPROVAL_PRESENTATION: Record<ExtensionApprovalState, ApprovalPresentation> = {
  approved: { tone: 'good', label: appCopy.settings.thirdPartyModuleList.approved },
  'not-needed': { tone: 'good', label: appCopy.settings.thirdPartyModuleList.contentOnly },
  pending: { tone: 'warn', label: appCopy.settings.thirdPartyModuleList.needsApproval },
  unavailable: { tone: 'error', label: appCopy.settings.thirdPartyModuleList.cannotBeApproved },
  invalid: { tone: 'error', label: appCopy.settings.thirdPartyModuleList.invalidSignature },
}

// Requested-access chips, in the full wording: what a review for a
// marketplace or GitHub install reads out. The broad scopes and unrecognized
// ones wear the warn tone, and their wording says the same thing, so the flag
// is never colour alone.
export function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return (
      <span className="text-meta text-[color:var(--text-subtle)]">
        {appCopy.settings.thirdPartyModuleList.noSpecialAccess}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => {
        const flagged = isBroadCapabilityPermission(permission) || !isKnownCapabilityPermission(permission)
        return (
          <Badge
            key={permission}
            tone={flagged ? 'warn' : 'neutral'}
            ariaLabel={`${describeCapabilityPermission(permission)} (${permission})`}
          >
            {describeCapabilityPermission(permission)}
          </Badge>
        )
      })}
    </div>
  )
}

/** What a row can ask of the page. */
export type ExtensionActions = {
  pendingId: string | null
  onReview: (module: ThirdPartyModuleView) => void
  onSetEnabled: (moduleId: string, enabled: boolean) => void
  onUninstall: ((module: ThirdPartyModuleView) => void) | null
  onReveal: ((module: ThirdPartyModuleView) => void) | null
  onCopyId: (module: ThirdPartyModuleView) => void
  /** Install the newer release its catalogue lists (it asks again when it asks for more). */
  onUpdate: ((module: ThirdPartyModuleView) => void) | null
}

function signatureFact(module: ThirdPartyModuleView): string {
  if (module.signature === 'invalid') return 'Invalid'
  if (!isSigned(module)) return 'Unsigned'
  const verified = module.signature === 'verified' ? 'Verified, s' : 'S'
  const signer = publisherName(module.manifest)
  if (signer) return `${verified}igned by ${signer}`
  return module.signer ? `${verified}igned, key ${module.signer.slice(0, 12)}` : `${verified}igned`
}

function approvalFact(module: ThirdPartyModuleView): string {
  if (module.approval.state === 'not-needed') return 'Not needed: it only carries content'
  return module.approval.state === 'approved' ? 'By you' : 'Not yet'
}

export function ExtensionListRow({
  module,
  overrides,
  actions,
  detailsOpen,
  onDetailsOpenChange,
}: {
  module: ThirdPartyModuleView
  overrides: ModuleEnablementOverrides
  actions: ExtensionActions
  detailsOpen: boolean
  onDetailsOpenChange: (open: boolean) => void
}): JSX.Element {
  const id = module.manifest.id
  const name = module.manifest.displayName
  const approved = isApproved(module)
  const invalid = module.signature === 'invalid'
  const enabled = resolveModuleEnabled(overrides, module)
  const pending = actions.pendingId === id
  const rendererLoadState = getThirdPartyRendererLoadState(id)
  const contributionError = getModuleContributionError(id)
  const problem = moduleProblem(module, rendererLoadState, contributionError)
  const reviewable = !approved && !invalid && module.approval.state === 'pending'
  const state = runState(module, enabled, rendererLoadState, contributionError)
  const doorIcon = moduleDoorIcon(module.extension)
  const { care, standard } = accessItems(module.manifest.permissions)

  const trailing = invalid ? (
    <CannotApproveTrailing />
  ) : !approved ? (
    <ReviewTrailing name={name} onReview={() => actions.onReview(module)} />
  ) : (
    <InstalledTrailing
      name={name}
      state={state}
      enabled={enabled}
      pending={pending}
      onToggle={(next) => actions.onSetEnabled(id, next)}
    />
  )

  const menuItems: OverflowMenuItem[] = [
    { id: 'details', label: appCopy.settings.thirdPartyModuleList.details, onSelect: () => onDetailsOpenChange(true) },
    ...(approved
      ? [
          {
            id: 'toggle',
            label: enabled
              ? appCopy.settings.thirdPartyModuleList.turnOff
              : appCopy.settings.thirdPartyModuleList.turnOn,
            disabled: pending,
            onSelect: () => actions.onSetEnabled(id, !enabled),
          },
        ]
      : reviewable
        ? [
            {
              id: 'review',
              label: appCopy.settings.thirdPartyModuleList.reviewAndApprove,
              onSelect: () => actions.onReview(module),
            },
          ]
        : []),
    ...(actions.onReveal
      ? [
          {
            id: 'files',
            label: appCopy.settings.thirdPartyModuleList.showFiles,
            onSelect: () => actions.onReveal?.(module),
          },
        ]
      : []),
    { id: 'copy', label: appCopy.settings.thirdPartyModuleList.copyId, onSelect: () => actions.onCopyId(module) },
    ...(actions.onUninstall ? [{ kind: 'separator' as const, id: 'sep' }] : []),
    ...(actions.onUninstall
      ? [
          {
            id: 'uninstall',
            label: module.development ? 'Remove development folder' : appCopy.settings.thirdPartyModuleList.uninstall,
            destructive: true,
            disabled: pending,
            onSelect: () => actions.onUninstall?.(module),
          },
        ]
      : []),
  ]

  // The row says a problem only where there is something to read: a failure,
  // or a signature that does not match; and why a worker waits to start.
  const update = updateText(module)
  const notice = problem
    ? { text: problemText(problem) }
    : update
      ? { text: update, ...(module.update?.held ? { tone: 'warn' as const } : {}) }
      : state === 'waiting' && module.launch.waiting
        ? { text: module.launch.waiting, tone: 'warn' as const }
        : null
  const updatable = Boolean(module.update && module.update.held !== 'owner' && !module.killed && actions.onUpdate)

  const source = sourceLabel(module)
  const origin = module.origin?.source
  const facts = [
    ...(source ? [{ term: 'Source', description: source }] : []),
    ...(origin
      ? [
          {
            term: 'From',
            description: `${origin.url}${origin.path ? ` (${origin.path})` : ''}${module.origin?.commit ? ` at ${module.origin.commit.slice(0, 12)}` : ''}`,
          },
        ]
      : []),
    ...(module.development ? [{ term: 'Folder', description: module.development.folder }] : []),
    { term: 'Signature', description: signatureFact(module) },
    { term: 'Approved', description: approvalFact(module) },
  ]

  return (
    <ExtensionRow
      module={module}
      doorIcon={doorIcon}
      meta={moduleMeta(module)}
      care={care}
      trailing={trailing}
      menuItems={menuItems}
      notice={notice}
      dimmed={approved && !enabled}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={onDetailsOpenChange}
      renderDetails={({ titleId }) => (
        <ExtensionDetails
          module={module}
          titleId={titleId}
          icon={<ExtensionMark module={module} doorIcon={doorIcon} size={40} />}
          status={
            approved ? (
              <ExtensionStateLabel state={state} />
            ) : (
              <span className="whitespace-nowrap text-meta text-[color:var(--tone-warn)]">
                {appCopy.settings.thirdPartyModuleList.notApproved}
              </span>
            )
          }
          adds={deriveContributions(module.extension)}
          care={care}
          standard={standard}
          facts={facts}
          actions={
            <>
              {reviewable ? (
                <OutlineButton size="xs" onClick={() => actions.onReview(module)}>
                  {appCopy.settings.thirdPartyModuleList.reviewAndApprove}
                </OutlineButton>
              ) : null}
              {updatable && module.update ? (
                <OutlineButton size="xs" disabled={pending} onClick={() => actions.onUpdate?.(module)}>
                  {module.update.held
                    ? `Review version ${module.update.version}`
                    : `Update to ${module.update.version}`}
                </OutlineButton>
              ) : null}
              <span className="flex-1" />
              {actions.onReveal ? (
                <GhostButton size="xs" onClick={() => actions.onReveal?.(module)}>
                  {appCopy.settings.thirdPartyModuleList.showFiles}
                </GhostButton>
              ) : null}
              {actions.onUninstall ? (
                <GhostButton size="xs" tone="danger" disabled={pending} onClick={() => actions.onUninstall?.(module)}>
                  {module.development ? 'Remove development folder' : appCopy.settings.thirdPartyModuleList.uninstall}
                </GhostButton>
              ) : null}
            </>
          }
        />
      )}
    />
  )
}

/** One group of rows under its heading; nothing at all when the group is empty. */
export function ExtensionGroup({
  title,
  count,
  children,
  id,
}: {
  title: string
  count: number
  children: React.ReactNode
  id: string
}): JSX.Element {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <SettingsSectionTitle id={id} count={count}>
        {title}
      </SettingsSectionTitle>
      {children}
    </section>
  )
}

export function ExtensionRows({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <SettingCard as="ul" ariaLabel={label}>
      {children}
    </SettingCard>
  )
}

export function NoExtensionsInstalled(): JSX.Element {
  return (
    <SettingCard>
      <EmptyState density="list" title={appCopy.settings.thirdPartyModuleList.noExtensionsInstalled} />
    </SettingCard>
  )
}

export function RejectedFolders({
  rejected,
}: {
  rejected: ReadonlyArray<{ path: string; issues: ModuleManifestIssue[] }>
}): JSX.Element | null {
  if (rejected.length === 0) return null
  return (
    <InlineNotice tone="warn">
      {rejected.length === 1
        ? 'An extension folder couldn’t be loaded: '
        : `${rejected.length} extension folders couldn’t be loaded: `}
      {rejected.map((entry) => entry.issues[0]?.message ?? entry.path).join('; ')}
    </InlineNotice>
  )
}
