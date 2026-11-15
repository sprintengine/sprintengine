import type { JSX } from 'react'

import type { MarketplaceMcpServerDisclosure } from '../../../../shared/electron-api'
import type { CapabilityPermission } from '../../../../shared/modules/permissions'
import { Badge, Checkbox, InlineNotice, TruncatedText } from '../ui'
import { PermissionChips } from '../settings/ThirdPartyModuleList'
import { copy as appCopy } from '../../../../shared/copy'

// What installing an extension would put on this machine, read out before the
// person trusts it. Every surface that asks for that trust — the storefront's
// detail panel, the update banner, an install from a GitHub URL — renders this
// one body, so none of them can disclose less than the others.
//
// Everything here came from main's verify, never from the registry entry the
// renderer holds: the permissions from the manifest that was actually
// downloaded, each MCP server exactly as the install would write it (the full
// command line, the endpoint, the names of the environment variables and
// headers it sets), and the commit the content is pinned to. The trust token
// verify issued installs exactly this and nothing else.

export type ExtensionTrustReviewData = {
  classification: 'verified' | 'community' | 'unsigned'
  permissions: CapabilityPermission[]
  // A skill plugin's payload is files, not permissions.
  files?: string[]
  mcpServers?: MarketplaceMcpServerDisclosure[]
  // Where the content was read from, and the commit it is pinned to.
  sourceUrl?: string
  commitSha?: string
  // The signer's key fingerprint (sha256 of the public key), when signed.
  keyFingerprint?: string
  // The bundle carries a module: code that runs inside the app.
  codeBearing?: boolean
}

export type ExtensionTrustReviewProps = ExtensionTrustReviewData & {
  publisher?: { name: string; verified: boolean }
  // The "I trust this code" answer, for unsigned code. Required before an
  // install can go ahead whenever `trustCodeRequired` says so; the surface
  // owns the state so its install button can read it.
  trustCode?: boolean
  onTrustCodeChange?: (next: boolean) => void
}

/**
 * Unsigned code asks for a second, explicit answer: nobody can say who wrote
 * it, and it runs with the app's access. The install action stays disabled
 * until the box is ticked.
 */
export function trustCodeRequired(review: Pick<ExtensionTrustReviewData, 'classification' | 'codeBearing'>): boolean {
  return review.classification === 'unsigned' && review.codeBearing === true
}

export function trustReviewReady(review: ExtensionTrustReviewData, trustCode: boolean): boolean {
  return !trustCodeRequired(review) || trustCode
}

const CLASSIFICATION_LABEL: Record<ExtensionTrustReviewData['classification'], string> = {
  verified: 'Verified',
  community: 'Community',
  unsigned: 'Unsigned',
}

function reviewCopy(review: ExtensionTrustReviewData): { heading: string; body: string } {
  if (trustCodeRequired(review)) {
    return {
      heading: appCopy.extensions.extensionTrustReview.unsignedCodeReviewBeforeTrusting,
      body: appCopy.extensions.extensionTrustReview.unsignedCodeThatRunsWith,
    }
  }
  const inlineMcp = !review.sourceUrl && (review.mcpServers?.length ?? 0) > 0
  if (inlineMcp) {
    return {
      heading: appCopy.extensions.extensionTrustReview.inlineMCPServerReviewIt,
      body: appCopy.extensions.extensionTrustReview.runsALocalCommandOr,
    }
  }
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
  const servers = props.mcpServers ?? []
  const inlineMcp = !props.sourceUrl && servers.length > 0
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
      {props.commitSha ? (
        <ReviewFact label={appCopy.extensions.extensionTrustReview.pinnedToCommit} value={props.commitSha} mono />
      ) : null}

      {inlineMcp || props.files?.length ? null : (
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
      {servers.length > 0 ? <McpServerListing servers={servers} /> : null}

      {trustCodeRequired(props) ? (
        <>
          <InlineNotice tone="warn">{appCopy.extensions.extensionTrustReview.unsignedCodeCanReadAnd}</InlineNotice>
          <Checkbox
            checked={props.trustCode === true}
            onChange={(next) => props.onTrustCodeChange?.(next)}
            disabled={!props.onTrustCodeChange}
            label={appCopy.extensions.extensionTrustReview.iTrustThisCodeAnd}
          />
        </>
      ) : null}
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

// Each server as the install writes it: the whole command line, or the
// endpoint, plus the names (never the values) of what it sets.
function McpServerListing({ servers }: { servers: MarketplaceMcpServerDisclosure[] }) {
  return (
    <div>
      <div className="text-meta font-semibold text-[color:var(--text-subtle)]">
        {appCopy.extensions.extensionTrustReview.adds}
        {servers.length}
        {appCopy.extensions.extensionTrustReview.mCPServer}
        {servers.length === 1 ? '' : 's'}
      </div>
      <ul className="mt-1 space-y-1.5">
        {servers.map((server) => (
          <li key={server.id} className="min-w-0">
            <div className="flex items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
              {/* The transport is stated once, here; the name never says it. */}
              <Badge className="shrink-0">{server.transport}</Badge>
              <TruncatedText as="span" text={server.name} className="min-w-0 font-medium" />
            </div>
            <div className="mt-0.5 break-all font-mono text-meta leading-4 text-[color:var(--text-subtle)]">
              {mcpServerCommandLine(server)}
            </div>
            {server.envKeys.length > 0 ? (
              <div className="mt-0.5 text-meta leading-4 text-[color:var(--text-subtle)]">
                {appCopy.extensions.extensionTrustReview.sets}
                <span className="font-mono">{server.envKeys.join(', ')}</span>
              </div>
            ) : null}
            {server.headerKeys.length > 0 ? (
              <div className="mt-0.5 text-meta leading-4 text-[color:var(--text-subtle)]">
                {appCopy.extensions.extensionTrustReview.sendsHeaders}
                <span className="font-mono">{server.headerKeys.join(', ')}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

// The command a stdio server runs, every argument included — an argument is
// where `sh -c '…'` hides — or the endpoint an http/sse server connects to.
export function mcpServerCommandLine(server: MarketplaceMcpServerDisclosure): string {
  if (server.transport === 'stdio') {
    return [server.command, ...server.args].filter(Boolean).join(' ') || '(no command)'
  }
  return server.url || '(no endpoint)'
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
