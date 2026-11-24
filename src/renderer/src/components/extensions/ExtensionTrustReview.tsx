import type { JSX } from 'react'

import type { CapabilityPermission } from '../../../../shared/modules/permissions'
import { Badge, TruncatedText } from '../ui'
import { PermissionChips } from '../settings/ThirdPartyModuleList'
import { copy as appCopy } from '../../../../shared/copy'

// What installing from the marketplace would put on this machine, read out
// before the person trusts it. Every surface that asks for that trust — the
// storefront's detail panel and the update banner — renders this one body, so
// neither can disclose less than the other.
//
// Everything here came from main's verify, never from the registry entry the
// renderer holds: the skill folders that were actually staged. The trust token
// verify issued installs exactly this and nothing else.

export type ExtensionTrustReviewData = {
  classification: 'verified' | 'community' | 'unsigned'
  permissions: CapabilityPermission[]
  // A skill plugin's payload is files, not permissions.
  files?: string[]
  // Where the content was read from.
  sourceUrl?: string
  // The signer's key fingerprint (sha256 of the public key), when signed.
  keyFingerprint?: string
}

export type ExtensionTrustReviewProps = ExtensionTrustReviewData & {
  publisher?: { name: string; verified: boolean }
}

const CLASSIFICATION_LABEL: Record<ExtensionTrustReviewData['classification'], string> = {
  verified: 'Verified',
  community: 'Community',
  unsigned: 'Unsigned',
}

function reviewCopy(review: ExtensionTrustReviewData): { heading: string; body: string } {
  if (review.files?.length) {
    return {
      heading: appCopy.extensions.extensionTrustReview.unsignedPluginSkillsReviewBefore,
      body: appCopy.extensions.extensionTrustReview.skillsAreInstructionsYourAgents,
    }
  }
  if (review.classification === 'unsigned') {
    return {
      heading: appCopy.extensions.extensionTrustReview.unsignedExtensionReviewBeforeTrustin,
      body: appCopy.extensions.extensionTrustReview.unsignedSoItsPublisherAnd,
    }
  }
  if (review.classification === 'verified') {
    return {
      heading: appCopy.extensions.extensionTrustReview.verifiedExtensionReviewWhatIt,
      body: appCopy.extensions.extensionTrustReview.signedByATrustedPublisher,
    }
  }
  return {
    heading: appCopy.extensions.extensionTrustReview.communityExtensionReviewItsAccess,
    body: appCopy.extensions.extensionTrustReview.unverifiedPublisherItsCodeRuns,
  }
}

export function ExtensionTrustReview(props: ExtensionTrustReviewProps): JSX.Element {
  const copy = reviewCopy(props)
  return (
    <div className="space-y-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3">
      <div>
        <div className="text-meta font-semibold text-[color:var(--text-default)]">{copy.heading}</div>
        <p className="mt-1 text-meta leading-4 text-[color:var(--text-subtle)]">{copy.body}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={props.classification === 'verified' ? 'good' : 'warn'}>
          {CLASSIFICATION_LABEL[props.classification]}
        </Badge>
        {props.publisher ? (
          <span className="text-meta text-[color:var(--text-muted)]">
            {props.publisher.name}
            {props.publisher.verified ? '' : ' · publisher not verified'}
          </span>
        ) : null}
      </div>

      {props.keyFingerprint ? (
        <ReviewFact label={appCopy.extensions.extensionTrustReview.signingKey} value={props.keyFingerprint} mono />
      ) : props.classification === 'unsigned' ? (
        <ReviewFact label={appCopy.extensions.extensionTrustReview.signingKey} value="None — not signed" />
      ) : null}

      {props.files?.length ? null : (
        <div>
          <div className="text-meta font-semibold text-[color:var(--text-subtle)]">
            {appCopy.extensions.extensionTrustReview.accessItRequests}
          </div>
          <div className="mt-1">
            <PermissionChips permissions={props.permissions} />
          </div>
        </div>
      )}

      {props.files?.length ? <TrustFileListing files={props.files} /> : null}
    </div>
  )
}

function ReviewFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-meta leading-4">
      <span className="shrink-0 text-[color:var(--text-subtle)]">{label}</span>
      <TruncatedText
        as="span"
        text={value}
        className={`min-w-0 text-[color:var(--text-muted)]${mono ? ' font-mono' : ''}`}
      />
    </div>
  )
}

// How many file rows show before the remainder collapses into a "+N more"
// line — the disclosure stays real without swallowing the panel.
const TRUST_FILES_LIMIT = 8

function TrustFileListing({ files }: { files: string[] }) {
  const visible = files.slice(0, TRUST_FILES_LIMIT)
  const hiddenCount = files.length - visible.length
  return (
    <div>
      <div className="text-meta font-semibold text-[color:var(--text-subtle)]">
        {appCopy.extensions.extensionTrustReview.adds}
        {files.length} skill{files.length === 1 ? '' : 's'}
        {appCopy.extensions.extensionTrustReview.toTheWorkspace}
      </div>
      <ul className="mt-1 space-y-0.5">
        {visible.map((file) => (
          <li key={file} className="min-w-0">
            <TruncatedText
              as="div"
              text={file}
              className="font-mono text-meta leading-4 text-[color:var(--text-muted)]"
            />
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <div className="mt-0.5 text-meta leading-4 text-[color:var(--text-subtle)]">+{hiddenCount} more</div>
      ) : null}
    </div>
  )
}
