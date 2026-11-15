import React from 'react'

import { WorkspaceTypeIcon } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import {
  EmptyState,
  IconButton,
  OutlineButton,
  PanelHeader,
  StarGlyph,
  StatusDot,
  Tooltip,
  TruncatedText,
} from '../../ui'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import type { AgentCli, Workspace } from '../../../../../shared/workspace'
import { getWorkspaceAccentHex, isStarred } from '../../../utils/highlight'
import { formatRelativeMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import { TerminalSessionIcon } from '../agentComposer/agentSpawnShared'
import { groupSessionItems } from '../workspaceManagerHelpers'

// Every running session in this window, by workspace: opened from the account
// menu. A session is the app's, not any one workspace's, so it lives with the
// account rather than with what is on screen.

// The bucket a session row is listed under. Almost every session belongs to a
// resident workspace. One keyed to an id no workspace row claims — a review
// guide (keyed to the review id), a door surface, an agent still running in a
// workspace that was closed — is `detached`: it gets its own labeled bucket so
// it stays visible and stoppable instead of vanishing from the list.
export type SessionGroup =
  | { kind: 'workspace'; id: string; label: string; workspace: Workspace }
  | { kind: 'detached'; id: string; label: string }

export type SessionItem = {
  group: SessionGroup
  kind: TerminalKind
  // Which runtime owns the process behind `sessionId`. Conversation agents have
  // no PTY, so stopping and suspending them go through the conversation runtime
  // rather than the terminal one.
  transport: 'terminal' | 'conversation'
  agentId: string | null
  terminalId: string | null
  label: string
  cli: AgentCli
  status: 'needs-input' | 'working' | 'idle' | 'failed'
  // Provenance of `status`: 'hook' = authoritative lifecycle-hook frame,
  // 'inferred' = a lifecycle stamp (spawn `starting`, watchdog `stalled`,
  // pty `exited`/`failed`) — never an output-timing guess.
  source: AgentStateSource
  // When the current status began (ms epoch); drives "active 2m" / "waiting 4m".
  activitySince: number
  // Most recent real activity (max of last output/input), for "idle · 12m".
  lastActivityAt: number | null
  // Exit code when `status === 'failed'`, else null.
  exitCode: number | null
  sessionId: string
}

function SessionAgentIcon({ item, className }: { item: SessionItem; className?: string }) {
  if (item.kind === 'terminal') {
    return <TerminalSessionIcon className={className} />
  }
  return <CliIcon cli={item.cli} className={className} />
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4.5" y="3.75" width="2.2" height="8.5" rx="0.9" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.3" y="3.75" width="2.2" height="8.5" rx="0.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function SessionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="12.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.5 9.25L10.25 12L7.5 14.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 14.75H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 20H15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

// Earned status dot: idle rows get no dot at all — a "working" indicator must be
// earned, not the default for every live row. Live attention states pulse; a
// crashed session shows a steady error dot.
function sessionStatusDot(status: SessionItem['status']): { tone: 'warn' | 'good' | 'error'; pulse: boolean } | null {
  switch (status) {
    case 'needs-input':
      return { tone: 'warn', pulse: true }
    case 'working':
      return { tone: 'good', pulse: true }
    case 'failed':
      return { tone: 'error', pulse: false }
    case 'idle':
      return null
  }
}

// Honest status + recency, e.g. "Needs input · waiting 4m", "Working · 2m",
// "idle · 18m", "Exit 1 · 8m ago". Carries the truth in text so the dot can stay
// decorative and idle rows can drop it entirely.
function sessionStatusMeta(item: SessionItem, now: number): string {
  switch (item.status) {
    case 'needs-input': {
      const rel = formatRelativeMs(item.activitySince, now)
      return rel ? `Needs input · waiting ${rel}` : 'Needs input'
    }
    case 'working': {
      const rel = formatRelativeMs(item.activitySince, now)
      return rel ? `Working · ${rel}` : 'Working'
    }
    case 'failed':
      return `Exit ${item.exitCode ?? 1} · ${formatRelativeMsAgo(item.activitySince, now)}`
    case 'idle': {
      const rel = formatRelativeMs(item.lastActivityAt ?? item.activitySince, now)
      return rel ? `idle · ${rel}` : 'idle'
    }
  }
}

export function SessionsPopover({
  items,
  workspaceOrder,
  onOpen,
  onPause,
  onStop,
  onStopGroup,
}: {
  items: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpen: (item: SessionItem) => void | Promise<void>
  onPause: (item: SessionItem) => void
  onStop: (item: SessionItem) => void
  onStopGroup: (group: SessionGroup, items: SessionItem[]) => void | Promise<void>
}) {
  // Re-render every 30s so relative times ("idle · 12m") stay fresh while open.
  const now = useRelativeNow(30_000)
  const groups = groupSessionItems(items, workspaceOrder)

  return (
    <div className="w-[420px] overflow-hidden">
      <PanelHeader title="Sessions" count={items.length > 0 ? items.length : undefined} />

      {groups.length === 0 ? (
        <EmptyState density="list" title="No sessions" />
      ) : (
        <div className="max-h-[420px] overflow-y-auto p-1">
          {groups.map((group) => {
            // A detached bucket has no workspace identity to wear: no type
            // icon, no star — the bare label is what distinguishes it from the
            // workspace groups above it. The group label carries the grouping
            // on its own; the per-group accent bar it used to sit beside was a
            // second left-bar idiom in the app (audit ruling 10).
            const workspace = group.group.kind === 'workspace' ? group.group.workspace : null
            const accent = workspace ? getWorkspaceAccentHex(workspace) : null
            const starred = workspace ? isStarred(workspace.highlight) : false
            const headerColor = accent ?? 'var(--text-subtle)'
            return (
              <div key={group.group.id} className="py-1">
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5 text-meta font-semibold"
                  style={{ color: headerColor }}
                >
                  {workspace ? <WorkspaceTypeIcon mode={workspace.mode} className="size-icon-xs shrink-0" /> : null}
                  <TruncatedText as="span" text={group.group.label} className="min-w-0" />
                  {starred ? (
                    <StarGlyph
                      filled
                      className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
                      label="Starred workspace"
                    />
                  ) : null}
                  {group.items.length > 1 ? (
                    // Destructive stays ink: the outline's danger tone recolours
                    // the label on hover and never fills the button with the
                    // error hue (button/component.md).
                    <OutlineButton
                      size="xs"
                      tone="danger"
                      onClick={() => void onStopGroup(group.group, group.items)}
                      className="ml-auto shrink-0"
                      aria-label={`Stop all ${group.items.length} sessions in ${group.group.label}`}
                    >
                      <StopIcon className="icon-xs" />
                      Stop all
                    </OutlineButton>
                  ) : null}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const identityParts =
                      item.kind === 'terminal'
                        ? [item.label.toLowerCase()]
                        : [item.cli].filter((value): value is string => Boolean(value))
                    // Lead the subline with honest status + recency, then identity.
                    const subline =
                      [sessionStatusMeta(item, now), ...identityParts].filter(Boolean).join(' · ') || item.cli
                    const dot = sessionStatusDot(item.status)
                    return (
                      <div
                        key={`${item.group.id}:${item.agentId ?? item.terminalId ?? item.sessionId}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-2.5 py-2 text-body text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)]"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="flex size-control-xs shrink-0 items-center justify-center rounded-sm border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)]">
                            <SessionAgentIcon item={item} className="size-icon-md" />
                          </span>
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <TruncatedText
                                as="span"
                                text={item.label}
                                className="min-w-0 font-medium text-[color:var(--text-strong)]"
                              />
                              {dot ? <StatusDot tone={dot.tone} pulse={dot.pulse} /> : null}
                            </span>
                            <TruncatedText
                              as="span"
                              text={subline}
                              className="mt-0.5 block text-micro text-[color:var(--text-subtle)]"
                            />
                          </span>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {/* Open activates the row's workspace and focuses its
                            pane. A detached session has no workspace to activate,
                            so the button is absent rather than present-and-inert;
                            Pause and Stop act on the process and still work. */}
                          {item.group.kind === 'workspace' ? (
                            <OutlineButton size="xs" onClick={() => void onOpen(item)}>
                              Open
                            </OutlineButton>
                          ) : null}

                          {/* Pause suspends a PTY. A conversation agent has none,
                            so the control is absent for those rows instead of
                            failing quietly against the terminal runtime. */}
                          {item.kind === 'agent' && item.transport === 'terminal' && item.status !== 'failed' ? (
                            <Tooltip content="Pause — suspends the agent to free memory; reopen resumes it">
                              <IconButton onClick={() => onPause(item)} aria-label={`Pause ${item.label}`}>
                                <PauseIcon className="icon-sm" />
                              </IconButton>
                            </Tooltip>
                          ) : null}

                          {/* A failed session has no process to stop — the action
                            disposes the retained crash row, so it reads as "Dismiss".
                            Neutral ink at rest: the tooltip and name say what it
                            does, and a status hue as a button ground is not a
                            button variant the system has. */}
                          <Tooltip content={item.status === 'failed' ? 'Dismiss' : 'Stop'}>
                            <IconButton
                              onClick={() => onStop(item)}
                              aria-label={`${item.status === 'failed' ? 'Dismiss' : 'Stop'} ${item.label}`}
                            >
                              <StopIcon className="icon-sm" />
                            </IconButton>
                          </Tooltip>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
