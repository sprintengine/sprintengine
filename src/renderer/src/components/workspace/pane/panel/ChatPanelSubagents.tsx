import React from 'react'

import { Badge, GhostButton, Section, TruncatedText } from '../../../ui'
import {
  SubagentFamilyStatus,
  type SubagentFamily,
  type SubagentFamilyMember,
  type SubagentFamilyParent,
} from '../../../panels/agentChat/subagentFamily'
import { SubagentIcon } from '../../../panels/agentChat/subagentIcon'
import { LaneGlyph } from '../../../panels/agentChat/subagentStatus'
import { PanelCard, PanelRow } from './PanelRow'
import { copy } from '../../../../../../shared/copy'

// The panel's way around a family: a card up to the parent of the agent in view,
// and Subagents, its own children, nothing at all when it has none. It reads
// `subagentFamilyStore`, so it knows nothing of how they are found or where they
// run; each row and the card carry where they go. Rows go into a subagent as a
// full chat in the main pane, and the panel then follows it.

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="m6 3.5 4.5 4.5L6 12.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SubagentRow({ member }: { member: SubagentFamilyMember }) {
  return (
    <PanelRow
      glyph={
        member.cli || member.source.kind === 'chat' ? (
          <SubagentIcon cli={member.cli} />
        ) : (
          <LaneGlyph tool={member.source.lane} />
        )
      }
      label={<TruncatedText as="span" text={member.name} />}
      detail={<SubagentFamilyStatus member={member} />}
      meta={
        <>
          {member.source.kind === 'chat' && member.source.subagent.readOnly ? (
            <Badge
              tone="neutral"
              ariaLabel={copy.workspace.pane.panel.chatPanelSubagents.readOnlyItCannotChange}
              className="whitespace-nowrap"
            >
              {copy.workspace.pane.panel.chatPanelSubagents.readOnly}
            </Badge>
          ) : null}
          <ChevronGlyph className="icon-xs" />
        </>
      }
      onClick={member.open}
      ariaLabel={member.name}
    />
  )
}

/** Those still at it first, each group in the order they started. */
export function subagentsInOrder(children: readonly SubagentFamilyMember[]): SubagentFamilyMember[] {
  const live = (member: SubagentFamilyMember) => member.state === 'working' || member.state === 'waiting'
  return [...children.filter(live), ...children.filter((member) => !live(member))]
}

function LoadEarlier({ family }: { family: SubagentFamily }) {
  return (
    <GhostButton
      size="inline"
      tone="subtle"
      align="start"
      disabled={family.loadingEarlier}
      onClick={family.loadEarlier}
      className="mt-1"
    >
      {family.loadingEarlier ? 'Loading earlier turns…' : 'Load earlier turns to see older subagents'}
    </GhostButton>
  )
}

export function ChatPanelSubagents({ family }: { family: SubagentFamily }) {
  // Older turns may hold some, but none is known: no section yet, only the way
  // to find out.
  if (family.children.length === 0) return family.hasMore ? <LoadEarlier family={family} /> : null
  return (
    <Section title={copy.workspace.pane.panel.chatPanelSubagents.subagents} inset="flush">
      <PanelCard>
        {subagentsInOrder(family.children).map((member) => (
          <SubagentRow key={member.key} member={member} />
        ))}
      </PanelCard>
      {family.hasMore ? <LoadEarlier family={family} /> : null}
    </Section>
  )
}

/** The way up from the agent in view: to the main chat, under the name it goes by, or to the agent that spawned it. */
export function ChatPanelParentLink({ parent }: { parent: SubagentFamilyParent }) {
  const main = parent.relation === 'Main chat'
  const title = main ? 'Main chat' : parent.name
  return (
    <div className="mt-1.5" data-panel-parent="">
      <PanelCard>
        <PanelRow
          glyph={
            <span className="flex items-center gap-1.5">
              <ChevronGlyph className="icon-xs -scale-x-100 text-[color:var(--text-subtle)]" />
              <SubagentIcon cli={parent.cli} />
            </span>
          }
          label={<TruncatedText as="span" text={title} />}
          detail={<TruncatedText as="span" text={main ? parent.name : parent.relation} />}
          onClick={parent.open}
          ariaLabel={copy.workspace.pane.panel.chatPanelSubagents.backTo(
            main ? copy.workspace.pane.panel.chatPanelSubagents.theMainChat(parent.name) : parent.name,
          )}
        />
      </PanelCard>
    </div>
  )
}
