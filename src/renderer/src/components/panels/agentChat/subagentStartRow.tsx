import { useState, type JSX } from 'react'
import { GhostButton, RowButton, TruncatedText } from '../../ui'
import type { AgentCli } from '../../../../../shared/workspace'
import { studioToolName } from './chatActivity'
import { ConversationMarkdown, useConversationLinkContext } from './conversationLinks'
import type { TranscriptToolEntry } from './conversationProjection'
import { harnessName, SubagentIcon, useLaneParentCli } from './subagentIcon'
import { openSubagentList, useOpenSubagent } from './subagentViewStack'
import { ToolKindGlyph } from './toolRows/ToolKindGlyph'

// `subagent.start` in the parent's transcript: one row that says who was
// started and opens it as a chat, in place of a tool call and its JSON.

export function isSubagentStart(tool: Pick<TranscriptToolEntry, 'name' | 'serverName'>): boolean {
  return studioToolName(tool) === 'subagent_start' || tool.name.endsWith('subagent.start')
}

function inputOf(tool: TranscriptToolEntry): Record<string, unknown> {
  const input = tool.input
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

// The call's answer, when it came back whole: a long reply reaches the
// transcript cut, so the id is looked for in the text as well, and the reply
// is left to its own chat.
function answerOf(tool: TranscriptToolEntry): { subagentId: string | null; result: string | null } {
  const output = typeof tool.output === 'string' ? tool.output : ''
  try {
    const parsed = JSON.parse(output) as { subagentId?: unknown; result?: unknown }
    return {
      subagentId: typeof parsed.subagentId === 'string' ? parsed.subagentId : null,
      result: typeof parsed.result === 'string' ? parsed.result : null,
    }
  } catch {
    return { subagentId: /"subagentId":\s*"([^"]+)"/u.exec(output)?.[1] ?? null, result: null }
  }
}

/** "Started a subagent · Cursor · muse-wonder-1.0 · Read-only". */
export function subagentStartWords(tool: TranscriptToolEntry): string {
  const input = inputOf(tool)
  const cli = typeof input.cli === 'string' ? harnessName(input.cli) : null
  const model = typeof input.cliModel === 'string' ? input.cliModel.replace(/\[.*$/u, '') : null
  return ['Started a subagent', cli, model, input.readOnly === true ? 'Read-only' : null].filter(Boolean).join(' · ')
}

export function SubagentStartRow({ tool }: { tool: TranscriptToolEntry }): JSX.Element {
  const open = useOpenSubagent()
  const context = useConversationLinkContext()
  const [replyOpen, setReplyOpen] = useState(false)
  const input = inputOf(tool)
  const { subagentId, result } = answerOf(tool)
  // A call that names no CLI starts one on this chat's own.
  const chatCli = useLaneParentCli()
  const harness = typeof input.cli === 'string' ? (input.cli as AgentCli) : chatCli
  const words = subagentStartWords(tool)
  return (
    <div className="min-w-0">
      <RowButton
        density="row"
        onClick={() => {
          if (subagentId) open?.({ kind: 'chat', agentId: subagentId })
          else if (context?.workspaceId) openSubagentList(context.workspaceId)
        }}
        aria-label={`${words}. Open it`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-meta text-[color:var(--text-muted)]">
          {harness ? <SubagentIcon cli={harness} /> : <ToolKindGlyph kind="subagent" />}
          <TruncatedText as="span" text={words} className="min-w-0" />
        </span>
      </RowButton>
      {result ? (
        <>
          <GhostButton
            size="inline"
            tone="subtle"
            align="start"
            aria-expanded={replyOpen}
            onClick={() => setReplyOpen(!replyOpen)}
          >
            {replyOpen ? 'Hide its reply' : 'Show its reply'}
          </GhostButton>
          {replyOpen ? (
            <div className="min-w-0 px-2 pb-1 text-body">
              <ConversationMarkdown text={result} />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
