// Studio's news about an agent this chat launched (`agent-notice`), drawn as a
// step: the logo of the harness it runs on, "Sub-agent Reviewer finished" and
// when, closed. Open, it is the agent's reply as markdown, in the panel every
// step's output opens into. The words the chat's agent was handed (who, which
// id, the reply quoted as untrusted output) are for that agent, not the person.

import { useRef } from 'react'
import type { ConversationAgentNotice } from '../../../../../../packages/conversation-protocol/src/public'
import { agentNoticeTitle } from '../../../../../../packages/conversation-timeline/src/agentNotices'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import type { AgentCli } from '../../../../../shared/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useClockFormat } from '../../../utils/clockFormat'
import { RowButton, Tooltip } from '../../ui'
import { markdownClipboardHtml } from '../../../utils/markdownClipboardHtml'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { formatMessageDateTime, formatMessageTime } from './liveElapsed'
import { SubagentIcon } from './subagentIcon'
import { ChevronRightGlyph, ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { forwardRowGroundClick, ToolPanel } from './toolRows/ToolRow'

export function AgentNoticeRows({
  id,
  notices,
  at,
}: {
  id: string
  notices: readonly ConversationAgentNotice[]
  at: number
}) {
  return (
    <div className="flex flex-col">
      {notices.map((notice, index) => (
        <AgentNoticeRow
          key={`${notice.agentId ?? notice.name}:${index}`}
          id={`${id}:${index}`}
          notice={notice}
          at={at}
        />
      ))}
    </div>
  )
}

function AgentNoticeRow({ id, notice, at }: { id: string; notice: ConversationAgentNotice; at: number }) {
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    `agent-notice:${id}`,
    false,
  )
  // A notice recorded before Studio named the harness: the sub-agent's record,
  // where this window holds it, says what it runs on; else the generic mark.
  const recordedProvider = useWorkspaceStore((state) =>
    notice.cli || !notice.agentId || !context?.workspaceId
      ? undefined
      : state.workspaces.find((workspace) => workspace.id === context.workspaceId)?.agents[notice.agentId]?.conversation
          ?.providerId,
  )
  const cli = (notice.cli ?? cliForConversationProvider(recordedProvider)) as AgentCli | null
  const buttonRef = useRef<HTMLButtonElement>(null)
  const title = agentNoticeTitle(notice)
  const reply = notice.reply?.trim() ?? ''
  const failed = notice.kind === 'failed'
  const label = (
    <>
      <span className="flex shrink-0 text-[color:var(--text-subtle)]">
        {cli ? <SubagentIcon cli={cli} className="icon-sm shrink-0" /> : <ToolKindGlyph kind="subagent" />}
      </span>
      <span className="min-w-0 truncate text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]">
        {title}
      </span>
    </>
  )
  return (
    <div data-agent-notice={notice.kind}>
      <div
        className={`group/tool-row flex min-w-0 items-center gap-1 rounded-sm pr-1.5 ${
          reply ? 'cursor-pointer transition-colors hover:bg-[color:var(--bg-hover)]' : ''
        }`}
        onClick={reply ? (event) => forwardRowGroundClick(event, buttonRef.current) : undefined}
      >
        <div className="flex min-w-0 max-w-fit shrink">
          {reply ? (
            <RowButton
              ref={buttonRef}
              density="flush"
              className="min-w-0 text-meta"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {label}
            </RowButton>
          ) : (
            <span className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-meta">{label}</span>
          )}
        </div>
        {failed && notice.reason ? (
          <span className="min-w-0 shrink-[2] truncate text-meta text-[color:var(--tone-error)]">{notice.reason}</span>
        ) : null}
        <span className="min-w-2 flex-1" />
        <NoticeClock at={at} />
        {reply ? (
          <ChevronRightGlyph
            className={`icon-xs shrink-0 text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)] motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : null}
      </div>
      {open && reply ? (
        <div data-agent-notice-reply="" className="mb-1.5 ml-6 mt-1 flex flex-col items-start gap-1.5 [&>*]:w-full">
          <ToolPanel copyText={reply} copyHtml={() => markdownClipboardHtml(reply)} mono={false}>
            {notice.replyTruncated ? (
              <p className="mb-2 text-micro text-[color:var(--text-subtle)]">
                Its start was cut to fit; the agent's own chat has the whole reply.
              </p>
            ) : null}
            <ConversationMarkdown text={reply} />
          </ToolPanel>
        </div>
      ) : null}
    </div>
  )
}

// When Studio brought the news, as a step says when it finished: the time,
// with the full date and time as its tooltip and its spoken reading.
function NoticeClock({ at }: { at: number }) {
  useClockFormat()
  if (!at) return null
  const full = `Arrived ${formatMessageDateTime(at)}`
  return (
    <span className="shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-subtle)]">
      <Tooltip content={full}>
        <time dateTime={new Date(at).toISOString()}>
          <span aria-hidden="true">{formatMessageTime(at)}</span>
          <span className="sr-only">{full}</span>
        </time>
      </Tooltip>
    </span>
  )
}
