import React from 'react'

import { pullRequestSlotChoice, CreatePullRequestControl } from '../../../panels/agentChat/createPullRequest'
import type { ChatPanelFacts } from '../../../panels/agentChat/chatPanelStore'
import { PullRequestGlyph } from '../../../ui'
import { PermissionFooter } from '../../agentComposer/spawnFooter'
import { LocalServerGlyph } from '../../../AppIcons'
import { localServersStripCopy } from '../../LocalServerMarks'
import { LocalServersMenu, LocalServerStateWord } from '../../LocalServersMenu'
import { PullRequestPanelButton } from '../../PullRequestMark'
import { UsageGlyph } from '../../SidebarAccountBar'
import { formatTokenCount } from '../../../../utils/tokenFormat'
import { PanelRow } from './PanelRow'

// The rows that are controls of their own, carried from the bar that used to
// sit under the composer. Each still does what it did there: the pull request
// opens and lists, "Create PR" runs its flow, the local servers open their menu
// (read-only on a paired machine, as `elsewhere` says). They read
// `ChatPanelFacts` and nothing else, so a chat here and a chat on a paired
// machine draw them alike.

const NO_NOW = (): number => Date.now()

/** The row's slot: this chat's open pull request, or "Create PR" when the branch is ready, never both. */
export function PullRequestRow({ facts, now = NO_NOW }: { facts: ChatPanelFacts; now?: () => number }) {
  const { pullRequests, createPullRequest, onStopWatchingPullRequest } = facts
  const slot = pullRequestSlotChoice(pullRequests, createPullRequest !== null)
  if (slot === null) return null
  return (
    <PanelRow
      glyph={<PullRequestGlyph state="open" className="icon-sm" />}
      label="Pull request"
      meta={
        <span className="flex min-w-0 justify-end" data-panel-pull-request-slot="">
          {slot === 'create' && createPullRequest ? (
            <CreatePullRequestControl slot={createPullRequest} />
          ) : (
            <PullRequestPanelButton
              pullRequests={pullRequests}
              now={now()}
              {...(onStopWatchingPullRequest ? { onStopWatching: onStopWatchingPullRequest } : {})}
            />
          )}
        </span>
      }
    />
  )
}

export function ServerRow({ localServers }: { localServers: NonNullable<ChatPanelFacts['localServers']> }) {
  const { workspaceId, servers, elsewhere } = localServers
  const copy = localServersStripCopy(servers)
  if (!copy) return null
  const single = servers.length === 1 ? servers[0] : null
  const ariaLabel = elsewhere ? `${copy.ariaLabel}, on ${elsewhere.machineName}` : copy.ariaLabel
  return (
    <LocalServersMenu
      workspaceId={workspaceId}
      servers={servers}
      ariaLabel={single ? `Local server ${single.title}` : 'Local servers from this conversation'}
      placement="bottom-end"
      fill
      {...(elsewhere ? { elsewhere } : {})}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <PanelRow
          glyph={<LocalServerGlyph className="icon-sm" />}
          label="Server"
          meta={
            <>
              <span className="min-w-0 truncate">{copy.label}</span>
              {single ? <LocalServerStateWord state={single.state} /> : <span className="shrink-0">{copy.state}</span>}
            </>
          }
          onClick={togglePopover}
          ariaLabel={ariaLabel}
          buttonRef={ref}
          buttonProps={{ ...triggerProps, 'data-panel-local-servers': servers.length }}
        />
      )}
    />
  )
}

export function PermissionsRow({ facts }: { facts: ChatPanelFacts }) {
  const { permissions } = facts
  if (!permissions)
    return facts.permissionLabel ? (
      <PanelRow glyph={<ShieldGlyph className="icon-sm" />} label="Permissions" meta={facts.permissionLabel} />
    ) : null
  return (
    <PanelRow
      glyph={<ShieldGlyph className="icon-sm" />}
      label="Permissions"
      meta={
        <PermissionFooter
          options={permissions.options}
          preset={permissions.preset}
          mode={permissions.mode}
          disabled={permissions.disabled}
          disabledReasons={permissions.disabledReasons}
          onSelect={permissions.onSelect}
        />
      }
    />
  )
}

function ShieldGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M8 2.2 13 4v3.8c0 3-2 5-5 6.2-3-1.2-5-3.2-5-6.2V4l5-1.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** What an agent with no context reading of its own has spent. */
export function TokensRow({ facts }: { facts: ChatPanelFacts }) {
  if (!facts.tokens) return null
  return (
    <PanelRow
      glyph={<UsageGlyph className="icon-sm" />}
      label="Tokens"
      meta={<span className="tabular-nums">{formatTokenCount(facts.tokens)}</span>}
    />
  )
}
