import React, { type JSX } from 'react'

import type {
  ModuleEnablementOverrides,
  ModuleManifestIssue,
  ModuleTrustStatus,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import {
  describeCapabilityPermission,
  isBroadCapabilityPermission,
  isKnownCapabilityPermission,
} from '../../../../shared/modules/permissions'
import { getModuleContributionError } from '../../modules/ModuleContributionBoundary'
import { getThirdPartyRendererLoadState } from '../../modules/third-party-loader'
import type { Tone } from '../ui/tokens'
import { Badge, EmptyState, GhostButton, InlineNotice, OutlineButton, SettingCard, type OverflowMenuItem } from '../ui'
import { deriveContributions, moduleDoorIcon } from './extensionContributions'
import {
  CannotTrustTrailing,
  ExtensionDetails,
  ExtensionMark,
  ExtensionRow,
  ExtensionStateLabel,
  InstalledTrailing,
  ReviewTrailing,
} from './ExtensionRow'
import {
  accessItems,
  isSigned,
  moduleMeta,
  moduleProblem,
  problemText,
  publisherName,
  resolveModuleEnabled,
  runState,
  sourceLabel,
} from './extensionsModel'
import { SettingsSectionTitle } from './SettingsAtoms'
import { copy as appCopy } from '../../../../shared/copy'

// Settings → Extensions: the two groups of extensions a person installed.
// "Needs review" first — the decision they owe is the first thing on the page —
// then "Installed", the trusted ones with their one switch. The rows and the
// details are in ExtensionRow; what talks to main is in useThirdPartyExtensions.

type TrustPresentation = { tone: Tone; label: string }

// The trust state in words, for the Plugins door's installed inventory.
export const TRUST_PRESENTATION: Record<ModuleTrustStatus, TrustPresentation> = {
  trusted: { tone: 'good', label: appCopy.settings.thirdPartyModuleList.trusted },
  // 'signed' is informational (valid signature, awaiting approval) — a neutral
  // status, not the accent (which is reserved for primary/selected chrome).
  signed: { tone: 'neutral', label: appCopy.settings.thirdPartyModuleList.signed },
  unsigned: { tone: 'warn', label: appCopy.settings.thirdPartyModuleList.unsigned },
  invalid: { tone: 'error', label: appCopy.settings.thirdPartyModuleList.invalidSignature },
}

// Requested-access chips, in the full consent wording: the disclosure a trust
// prompt for a marketplace or GitHub install reads out. Disclosure only — the
// text is what the module says it does, never what the app prevents. The broad
// scopes and unrecognized ones wear the warn tone, and their wording says the
// same thing, so the flag is never colour alone.
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
  onRevokeTrust: (module: ThirdPartyModuleView) => void
  onUninstall: ((module: ThirdPartyModuleView) => void) | null
  onReveal: ((module: ThirdPartyModuleView) => void) | null
  onCopyId: (module: ThirdPartyModuleView) => void
}

function signatureFact(module: ThirdPartyModuleView): string {
  if (module.trust === 'invalid') return 'Invalid'
  if (!isSigned(module)) return 'Unsigned'
  const signer = publisherName(module.manifest)
  if (signer) return `Signed by ${signer}`
  return module.fingerprint ? `Signed, key ${module.fingerprint.slice(0, 12)}` : 'Signed'
}

function trustFact(module: ThirdPartyModuleView): string {
  if (module.trust !== 'trusted') return 'Not yet'
  return module.trustedVia === 'publisher' ? 'By its publisher’s key' : 'By you'
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
  const trusted = module.trust === 'trusted'
  const invalid = module.trust === 'invalid'
  const enabled = resolveModuleEnabled(overrides, module)
  const pending = actions.pendingId === id
  const rendererLoadState = getThirdPartyRendererLoadState(id)
  const contributionError = getModuleContributionError(id)
  const problem = moduleProblem(module, rendererLoadState, contributionError)
  const reviewable = !trusted && !invalid
  const state = runState(module, enabled, rendererLoadState, contributionError)
  const doorIcon = moduleDoorIcon(module.extension)
  const { care, standard } = accessItems(module.manifest.permissions)

  const trailing = invalid ? (
    <CannotTrustTrailing />
  ) : !trusted ? (
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
    ...(trusted
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
              label: appCopy.settings.thirdPartyModuleList.reviewAndTrust,
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
    ...((trusted && module.trustedVia !== 'publisher') || actions.onUninstall
      ? [{ kind: 'separator' as const, id: 'sep' }]
      : []),
    ...(trusted && module.trustedVia !== 'publisher'
      ? [
          {
            id: 'revoke',
            label: appCopy.settings.thirdPartyModuleList.revokeTrust,
            disabled: pending,
            onSelect: () => actions.onRevokeTrust(module),
          },
        ]
      : []),
    ...(actions.onUninstall
      ? [
          {
            id: 'uninstall',
            label: appCopy.settings.thirdPartyModuleList.uninstall,
            destructive: true,
            disabled: pending,
            onSelect: () => actions.onUninstall?.(module),
          },
        ]
      : []),
  ]

  // The row says a problem only where there is something to read: a failure,
  // or a signature that does not match.
  const notice = problem ? { text: problemText(problem) } : null

  const source = sourceLabel(module)
  const facts = [
    ...(source ? [{ term: 'Source', description: source }] : []),
    { term: 'Signature', description: signatureFact(module) },
    { term: 'Trusted', description: trustFact(module) },
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
      dimmed={trusted && !enabled}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={onDetailsOpenChange}
      renderDetails={({ titleId }) => (
        <ExtensionDetails
          module={module}
          titleId={titleId}
          icon={<ExtensionMark module={module} doorIcon={doorIcon} size={40} />}
          status={
            trusted ? (
              <ExtensionStateLabel state={state} />
            ) : (
              <span className="whitespace-nowrap text-meta text-[color:var(--tone-warn)]">
                {appCopy.settings.thirdPartyModuleList.notTrusted}
              </span>
            )
          }
          adds={deriveContributions(module.extension)}
          care={care}
          standard={standard}
          facts={facts}
          actions={
            <>
              {trusted && module.trustedVia !== 'publisher' ? (
                <GhostButton size="xs" disabled={pending} onClick={() => actions.onRevokeTrust(module)}>
                  {appCopy.settings.thirdPartyModuleList.revokeTrust}
                </GhostButton>
              ) : reviewable ? (
                <OutlineButton size="xs" onClick={() => actions.onReview(module)}>
                  {appCopy.settings.thirdPartyModuleList.reviewAndTrust}
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
                  {appCopy.settings.thirdPartyModuleList.uninstall}
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
