import React from 'react'

import CliIcon from '../CliIcon'
import { ChatGlyph, GitBranchGlyph, LocalServerGlyph, RemoteMachineGlyph, WslMachineGlyph } from '../AppIcons'
import { ContextRing, PullRequestGlyph, RowButton, Section, TruncatedText, WorkingMark } from '../ui'
import { formatRelativeMs } from '../../utils/relativeTime'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import type { AgentCli } from '../../../../shared/workspace'
import type { SessionContextUsage } from '../../../../shared/electron-api'
import { PULL_REQUEST_TONE_VAR, pullRequestTone, type BranchPullRequest } from '../../../../shared/git/pull-request'
import type { StudioLocalServer } from '../../../../../packages/studio-protocol/src/public'
import { PullRequestPeekMark, openPullRequestExternally, pullRequestMenuGroups } from './PullRequestMark'
import { localServerStateWord } from './LocalServersMenu'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import { formatTokenCount } from '../../utils/tokenFormat'

// The conversation peek — one hover surface for "what is this chat", opened
// from a sidebar row and from an agent tab.
//
// This file is the PRESENTATIONAL half: identity in, markup out, no portal, no
// hover mechanics, no IPC — so it server-renders under the repo's static-markup
// test harness and so the two anchors (row, tab) can hold it in whichever shell
// they already own. `ConversationPeekPopover` and `AgentTabIdentityPopover` are
// the two shells; neither draws any of this itself.
//
// A GLANCE, NOT A READER (owner, 2026-10-04). The card used to carry the
// conversation itself — every captured prompt as a scrolling thread, the files
// the agent changed, the session id with a copy button. The conversation's
// rail now shows the whole history in place, so the card is back to what a
// hover is for: at most four short facts, one per line — the machine when it
// is not this one, the branch, the model, and how much of the context window
// it has spent, in tokens. Not the project (the row already sits under it),
// and not "this computer", which is the unmarked default everywhere else in
// the sidebar too.
//
// ONE AGENT PER CARD (owner, 2026-09-09). The sidebar already lists a chat's
// agents as its own sub-lines, so the person points at the one they mean and
// the card is that agent's.
//
// WHAT THE CHAT HOLDS (owner, 2026-11-15). Below the facts, the card lists
// what the chat has out in the world, each a short section that is not drawn
// when it is empty: its agents (the chat's others, and how many sub-agents
// are out), each a way into that agent; its pull requests, open ones first,
// in a list that scrolls past a few rows, each a link to GitHub; and the
// local servers its agents started. Everything here rides the identity the
// shell built from what the row already reads (the Studio's records, or a
// paired machine's list), so a chat on another machine says the same.

/**
 * The chat's live state, in the corner's voice.
 *
 * `kind` and not a `Tone`, because the corner is not a status dot and never
 * was: it is the SIDEBAR's own mark — the working mark — and one word beside
 * them. Three kinds are all the corner can draw differently: dots and muted
 * ink, no dots and subtle ink, no dots and muted ink.
 */
export type ConversationPeekStatus = {
  /**
   * - `working` — the dots, and the word.
   * - `idle` — no dots, and the quieter ink: nothing is happening, and a chat
   *   at rest should not be as loud as one that is running.
   * - `attention` — no dots, muted ink. Waiting, Failed, Paused: states worth
   *   the same weight as Working without claiming motion that is not there.
   */
  kind: 'working' | 'idle' | 'attention'
  /** The one word (or short phrase) the corner says: "Working", "Idle", "Failed". */
  label: string
  /**
   * A label that reads its age once there is one: from a minute after `since`
   * the corner says "`label` · 2m" ("Paused · 2m", "Last typed · 12m") in
   * place of the plain `label` above. It formats the age on its own clock, so
   * the age keeps moving while the card is open and nothing else redraws.
   */
  aged?: { label: string; since: number }
}

/**
 * The agent this card is about. One, always — see the file header.
 *
 * The session figures below ride the identity rather than being read here
 * because the card is presentational and the shells already hold a session
 * snapshot (the sidebar) or an agent record (the tab). A component that fetched
 * its own would be a second source for facts the anchor is already drawing.
 */
export type ConversationPeekAgent = {
  /** The terminal session this card is about — what the shells key on. */
  sessionId: string
  /**
   * The agent's own name ("Gael Corry"), which the card's agent list shows;
   * absent where the shell knows none, and the list then says the chat's.
   */
  name?: string | null
  /** The agent behind the session, when there is one. */
  agentId?: string | null
  /** Runtime id; null when unknown. */
  cli: AgentCli | null
  /** Launch model id; null → the CLI's own default. */
  model: string | null
  /** Subagents out right now. Replaces the corner's word while it is above zero. */
  activeSubagents: number
  /**
   * The pull requests this conversation has opened, newest first — main's own
   * union of the ones on its branch and the ones it opened itself in any
   * repository (epic `pull-request-marks`, decision 10). Empty draws nothing.
   *
   * An OUTCOME of the conversation rather than a place: the branch line says
   * where the work is being done, this says where it went, and only this card
   * knows which conversation sent it there.
   */
  pullRequests: BranchPullRequest[]
  /**
   * Context-window usage, or null when nothing has reported any. Null draws no
   * context line at all: 0% and "this runtime reports none" are different
   * facts, and a line at 0% would claim the first.
   */
  contextUsage: SessionContextUsage | null
}

/** The machine a chat runs on when it is not this computer. */
export type ConversationPeekMachine = {
  /** "WSL: Ubuntu", or an SSH machine's or a paired machine's name. */
  label: string
  kind: 'wsl' | 'remote'
}

/**
 * Where the chat runs. Every field is independently optional — a chat in a
 * plain folder has no branch, and a line with nothing to say is not drawn.
 */
export type ConversationPeekPlace = {
  /** Null on this computer — local is the unmarked default. */
  machine: ConversationPeekMachine | null
  branch: string | null
}

/** A local server one of the chat's agents started, as the card lists it. */
export type ConversationPeekServer = Pick<StudioLocalServer, 'id' | 'url' | 'title' | 'state'>

export type ConversationPeekIdentity = {
  /** The chat's name — the tab's or the row's title. */
  name: string
  /**
   * Goes to this agent's own view: its tab here, or the pane following it on
   * its machine. Absent where there is nowhere further to go (the tab's own
   * card, opened from the tab it would go to).
   */
  open?: (() => void) | null
  /** The local servers the chat's agents started, newest first. Absent or empty draws no section. */
  servers?: readonly ConversationPeekServer[]
  /**
   * Opens one of them. Absent, the servers are listed as facts: a paired
   * machine's address is that machine's own, and opens only there.
   */
  openServer?: ((server: ConversationPeekServer) => void) | null
  /**
   * Where it runs. Absent on the TAB's card: a tab sits inside the chat's own
   * window, whose header already says the machine and branch.
   */
  place?: ConversationPeekPlace | null
  /** The corner's state; null to omit it entirely. */
  status: ConversationPeekStatus | null
  /** The one agent whose conversation this card shows. */
  agent: ConversationPeekAgent
}

/**
 * The corner: the sidebar's own working mark and one word, and nothing else
 * added for a state (mockup frame 2).
 *
 * Never a `StatusDot` — that was the shipped card's mistake and it is the whole
 * point of this revision. The row says "working" with three staggered dots; the
 * card saying it with a pulsing green disc six pixels away made two vocabularies
 * for one fact, and the reader has to learn both.
 *
 * Subagents REPLACE the word rather than adding to it: "2 running" is strictly
 * more than "Working" — it says the agent is working AND what it is doing — so
 * a card that said both would be spending a line on the weaker half.
 */
function LiveCorner({ status, activeSubagents }: { status: ConversationPeekStatus; activeSubagents: number }) {
  const working = status.kind === 'working'
  const label = working && activeSubagents > 0 ? `${activeSubagents} running` : status.label
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-meta ${
        status.kind === 'idle' ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-muted)]'
      }`}
    >
      {working ? (
        <>
          {/* The mark carries the accessible name and the word beside it is
              decorative, so the state is announced once rather than twice.
              (`WorkingMark` is `role="img"` with a label by construction —
              it is the sidebar's mark, and this is the same mark, seeded the
              same way so the card moves like the row it opened from.) */}
          <WorkingMark label={label} />
          <span aria-hidden="true">{label}</span>
        </>
      ) : (
        <span>{status.aged ? <LabelWithAge label={label} aged={status.aged} /> : label}</span>
      )}
    </span>
  )
}

/**
 * "Paused · 2m" once a minute has passed, else the plain label, on a clock of
 * its own. An age with no label of its own (a chat's) is the time alone: "2m".
 */
function LabelWithAge({ label, aged }: { label: string; aged: { label: string; since: number } }) {
  const now = useRelativeNow()
  const age = formatRelativeMs(aged.since, now)
  return <>{age ? (aged.label ? `${aged.label} · ${age}` : age) : label}</>
}

/**
 * The context line's words: "84k / 200k tokens · 42%", or "42% of context
 * used" when the runtime has not said how big its window is.
 *
 * The used count is DERIVED from the whole percent the session reports, so it
 * is good to one percent of the window — which is all a glance asks of it.
 */
export function contextUsageText(usage: SessionContextUsage): string {
  const percentage = Math.max(0, Math.min(100, Math.round(usage.usedPercentage)))
  const size = usage.contextWindowSize
  if (!size || !Number.isFinite(size) || size <= 0) return `${percentage}% of context used`
  const used = (size * percentage) / 100
  return `${formatTokenCount(used)} / ${formatTokenCount(size)} tokens · ${percentage}%`
}

const MACHINE_GLYPH = {
  wsl: WslMachineGlyph,
  remote: RemoteMachineGlyph,
} as const

/**
 * One fact: a glyph in a fixed gutter and a value that truncates. The glyph is
 * decorative and the label is the line's accessible name, so a screen reader
 * hears "Branch: main" rather than "main" on its own.
 */
function Fact({
  glyph,
  label,
  children,
  mono = false,
}: {
  glyph: React.ReactNode
  label: string
  children: string
  mono?: boolean
}) {
  return (
    <li className="flex min-w-0 items-center gap-2" aria-label={`${label}: ${children}`}>
      <span className="flex w-3.5 shrink-0 justify-center text-[color:var(--text-subtle)]" aria-hidden="true">
        {glyph}
      </span>
      <TruncatedText
        as="span"
        text={children}
        className={`min-w-0 flex-1 text-meta text-[color:var(--text-muted)] ${mono ? 'font-mono' : ''}`}
      />
    </li>
  )
}

/** A section's list: rows on the card's own inset, scrolling past a few when there are many. */
function SectionList({
  children,
  label,
  scroll = false,
}: {
  children: React.ReactNode
  label: string
  scroll?: boolean
}) {
  return (
    <ul
      aria-label={label}
      className={`m-0 flex list-none flex-col px-1.5 ${scroll ? 'max-h-40 overflow-y-auto overscroll-contain' : ''}`}
    >
      {children}
    </ul>
  )
}

/** One row: a glyph, the words, and a fact at its end. A button where it leads somewhere, plain words where it does not. */
function SectionRow({
  glyph,
  children,
  end,
  ariaLabel,
  onOpen,
  current = false,
}: {
  glyph: React.ReactNode
  children: React.ReactNode
  end?: React.ReactNode
  ariaLabel: string
  onOpen?: (() => void) | null
  current?: boolean
}) {
  const body = (
    <>
      <span className="flex w-3.5 shrink-0 justify-center" aria-hidden="true">
        {glyph}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">{children}</span>
      {end ? (
        <span className="flex shrink-0 items-center gap-1 text-meta text-[color:var(--text-subtle)]">{end}</span>
      ) : null}
    </>
  )
  return (
    <li className="min-w-0">
      {onOpen ? (
        <RowButton
          density="row"
          selected={current || undefined}
          aria-label={ariaLabel}
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-2 py-1 text-meta"
        >
          {body}
        </RowButton>
      ) : (
        <div aria-label={ariaLabel} className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-meta">
          {body}
        </div>
      )}
    </li>
  )
}

/**
 * The chat's agents: every one the row holds, the one this card is about
 * marked, each a way into it; then how many sub-agents are out, which goes to
 * this agent's own view, where they are listed by name. Drawn only when there
 * is more than this one agent to name.
 */
function AgentsSection({
  identity,
  roster,
}: {
  identity: ConversationPeekIdentity
  roster: readonly ConversationPeekIdentity[]
}) {
  const others = roster.filter((entry) => entry.agent.sessionId !== identity.agent.sessionId)
  // The corner's rule: a count from an agent that is not working is stale.
  const out = identity.status?.kind === 'working' ? identity.agent.activeSubagents : 0
  if (others.length === 0 && out <= 0) return null
  const listed = others.length > 0 ? roster : []
  return (
    <Section title="Agents" count={listed.length > 0 ? listed.length : undefined} inset={false}>
      <SectionList label="Agents in this chat">
        {listed.map((entry) => {
          const name = entry.agent.name?.trim() || entry.name
          const current = entry.agent.sessionId === identity.agent.sessionId
          const state = entry.status?.label ?? null
          return (
            <SectionRow
              key={entry.agent.sessionId}
              glyph={
                entry.agent.cli ? (
                  <CliIcon cli={entry.agent.cli} className="icon-xs" />
                ) : (
                  <ChatGlyph className="icon-xs text-[color:var(--text-subtle)]" />
                )
              }
              end={state}
              ariaLabel={`${name}${state ? `, ${state.toLowerCase()}` : ''}${entry.open ? '. Open this agent' : ''}`}
              onOpen={entry.open ?? null}
              current={current}
            >
              <TruncatedText as="span" text={name} className="min-w-0 flex-1 text-[color:var(--text-default)]" />
            </SectionRow>
          )
        })}
        {out > 0 ? (
          <SectionRow
            glyph={<WorkingMark label={`${out} sub-agent${out === 1 ? '' : 's'} running`} />}
            ariaLabel={`${out} sub-agent${out === 1 ? '' : 's'} running${identity.open ? '. Open the agent that started them' : ''}`}
            onOpen={identity.open ?? null}
          >
            <span className="min-w-0 flex-1 truncate text-[color:var(--text-muted)]">
              {out} sub-agent{out === 1 ? '' : 's'} running
            </span>
          </SectionRow>
        ) : null}
      </SectionList>
    </Section>
  )
}

/**
 * Every pull request the chat opened, open ones first and newest first within
 * each state (`pullRequestMenuGroups`, the order the header mark's menu
 * keeps), each a link to GitHub. The list scrolls past a few rows, so an
 * agent that opened seventy is a short box rather than a column off the
 * screen. The state is the glyph's shape and its tone, and the row's name
 * says it in words.
 */
function PullRequestsSection({ pullRequests, now }: { pullRequests: readonly BranchPullRequest[]; now: number }) {
  const rows = pullRequestMenuGroups(pullRequests, now).flatMap((group) => group.rows)
  if (rows.length === 0) return null
  return (
    <Section title="Pull requests" count={rows.length} inset={false}>
      <SectionList label="Pull requests from this chat" scroll={rows.length > 5}>
        {rows.map((row) => (
          <SectionRow
            key={row.url}
            glyph={
              <span style={{ color: PULL_REQUEST_TONE_VAR[pullRequestTone(row.state)] }}>
                <PullRequestGlyph state={row.state} className="icon-xs" />
              </span>
            }
            end={row.age || undefined}
            ariaLabel={row.ariaLabel}
            onOpen={() => openPullRequestExternally(row.url)}
          >
            <span className="shrink-0 font-mono tabular-nums text-[color:var(--text-muted)]">{row.number}</span>
            {row.title ? (
              <TruncatedText as="span" text={row.title} className="min-w-0 flex-1 text-[color:var(--text-default)]" />
            ) : null}
          </SectionRow>
        ))}
      </SectionList>
    </Section>
  )
}

/** The address without its scheme: "localhost:5173", which is what a person reads a dev server by. */
function serverAddress(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '')
}

/**
 * The local servers the chat's agents started, running ones first, each with
 * its state in words. A row opens the server where the shell can; where it
 * cannot (a paired machine's own localhost) the row is the fact alone.
 */
function ServersSection({
  servers,
  openServer,
}: {
  servers: readonly ConversationPeekServer[]
  openServer: ((server: ConversationPeekServer) => void) | null
}) {
  if (servers.length === 0) return null
  const rank = (server: ConversationPeekServer) => (server.state === 'stopped' ? 1 : 0)
  const ordered = [...servers].sort((a, b) => rank(a) - rank(b))
  return (
    <Section title="Servers" count={ordered.length} inset={false}>
      <SectionList label="Local servers in this chat" scroll={ordered.length > 4}>
        {ordered.map((server) => {
          const state = localServerStateWord(server.state)
          const address = serverAddress(server.url)
          return (
            <SectionRow
              key={server.id}
              glyph={<LocalServerGlyph className="icon-xs text-[color:var(--text-subtle)]" />}
              end={state}
              ariaLabel={`Local server ${server.title}, ${address}, ${state.toLowerCase()}${openServer ? '. Open it' : ''}`}
              onOpen={openServer ? () => openServer(server) : null}
            >
              <TruncatedText
                as="span"
                text={server.title}
                className="min-w-0 shrink text-[color:var(--text-default)]"
              />
              {server.title !== address ? (
                <span className="min-w-0 shrink truncate font-mono text-[color:var(--text-subtle)]">{address}</span>
              ) : null}
            </SectionRow>
          )
        })}
      </SectionList>
    </Section>
  )
}

/**
 * The card: a header that names the chat and says what it is doing, then one
 * line per fact the shells could answer, then what the chat holds (its
 * agents, its pull requests, its servers). A fact nobody knows is not drawn —
 * an empty "Branch" line is the card describing its own absence.
 *
 * `roster` is every agent the row the card opened from holds, this one among
 * them; absent, the card is about one agent and lists no others.
 */
export function ConversationPeekCard({
  identity,
  now,
  roster,
}: {
  identity: ConversationPeekIdentity
  now: number
  roster?: readonly ConversationPeekIdentity[]
}) {
  const agent = identity.agent
  const place = identity.place ?? null
  const runtime = agent.cli ? labelForCliRuntime(agent.cli) : null
  // "claude-opus-5 · Claude Code", the model first because it is what differs
  // between two chats on the same runtime.
  const modelLine = [agent.model ?? (runtime ? 'Default model' : null), runtime].filter(Boolean).join(' · ')
  const MachineGlyph = place?.machine ? MACHINE_GLYPH[place.machine.kind] : null
  return (
    <>
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        {/* The name in full is what the row's own truncation tooltip used to
            show; this header takes that job, which is how the row keeps to one
            hover surface at a time. */}
        <TruncatedText
          as="span"
          text={identity.name}
          className="min-w-0 flex-1 text-heading font-semibold text-[color:var(--text-strong)]"
        />
        <PullRequestPeekMark pullRequests={agent.pullRequests} now={now} />
        {identity.status ? <LiveCorner status={identity.status} activeSubagents={agent.activeSubagents} /> : null}
      </div>

      <ul className="m-0 flex list-none flex-col gap-1 px-3 pb-2.5 pt-0.5">
        {place?.machine && MachineGlyph ? (
          <Fact label="Machine" glyph={<MachineGlyph className="icon-xs" />}>
            {place.machine.label}
          </Fact>
        ) : null}
        {place?.branch ? (
          <Fact label="Branch" glyph={<GitBranchGlyph className="icon-xs" />} mono>
            {place.branch}
          </Fact>
        ) : null}
        {modelLine ? (
          <Fact
            label="Model"
            glyph={agent.cli ? <CliIcon cli={agent.cli} className="icon-xs" /> : <span className="icon-xs" />}
          >
            {modelLine}
          </Fact>
        ) : null}
        {agent.contextUsage ? (
          <Fact label="Context" glyph={<ContextRing usedPercentage={agent.contextUsage.usedPercentage} decorative />}>
            {contextUsageText(agent.contextUsage)}
          </Fact>
        ) : null}
      </ul>

      <div className="flex flex-col pb-1.5 empty:hidden">
        <AgentsSection identity={identity} roster={roster ?? [identity]} />
        <PullRequestsSection pullRequests={agent.pullRequests} now={now} />
        <ServersSection servers={identity.servers ?? []} openServer={identity.openServer ?? null} />
      </div>
    </>
  )
}
