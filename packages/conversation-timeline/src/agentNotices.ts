// A launch notice as rows: the news Studio gives a chat about an agent it
// launched (`agent-notice`), one row per agent, rather than the words the
// chat's own agent was handed.
//
// The agent reads the notice as plain text, so its words are written for an
// agent: who, what happened, which id to read more with, and the agent's reply
// quoted between `<<` and `>>` as untrusted output. A person reading the chat
// wants none of that framing: they want "Sub-agent X finished" and the reply,
// as markdown. Studio records each agent's news beside the words, on the
// message's origin (`notices`). A message recorded before it did has only the
// words, which Studio wrote to one pattern, and a notice about one agent is
// read back from them; a notice about several, or words that do not follow the
// pattern, stays as its words.

import type { ConversationAgentNotice, ConversationAgentNoticeKind, ConversationMessageOrigin } from './protocol.js'

const LAUNCHED = ', which you launched, '
const QUOTED = 'quoted as that agent wrote it:'

/** The news a Studio message gives, one entry per agent, or null for a message that is not that. */
export function agentNoticesOf(
  origin: ConversationMessageOrigin | null | undefined,
  text: string,
): ConversationAgentNotice[] | null {
  if (origin?.kind !== 'studio' || origin.reason !== 'agent-notice') return null
  if (origin.notices?.length) return origin.notices
  const notice = agentNoticeFromText(text)
  return notice ? [notice] : null
}

/**
 * One agent's news, read back from the words Studio wrote for it
 * (`composeLaunchNotice` in the desktop's main process). Null for anything
 * else, a notice about several agents included.
 */
export function agentNoticeFromText(text: string): ConversationAgentNotice | null {
  // The product's name in brackets opens it; the row says whose it is.
  const words = text.trimStart().replace(/^\[[^\]\n]*\]\s*/u, '')
  const subject = /^(Sub-agent|Agent) /u.exec(words)
  if (!subject) return null
  const launched = words.indexOf(LAUNCHED)
  if (launched < 0) return null
  const name = words.slice(subject[0].length, launched).trim()
  if (!name || name.includes('\n')) return null
  const rest = words.slice(launched + LAUNCHED.length)
  const happened = whatHappened(rest)
  if (!happened) return null
  const id = /\((?:subagentId "([^"]+)"|workspaceId "[^"]*", agentId "([^"]+)")\)/u.exec(rest)
  const agentId = id?.[1] ?? id?.[2]
  const reply = quotedReply(rest)
  return {
    kind: happened.kind,
    name,
    ...(subject[1] === 'Sub-agent' ? { subagent: true as const } : {}),
    ...(agentId ? { agentId } : {}),
    ...(reply ? { reply } : {}),
    ...(reply && rest.includes('Its start was cut to fit') ? { replyTruncated: true as const } : {}),
    ...(happened.reason ? { reason: happened.reason } : {}),
  }
}

function whatHappened(rest: string): { kind: ConversationAgentNoticeKind; reason?: string } | null {
  if (rest.startsWith('finished its turn.')) return { kind: 'finished' }
  if (rest.startsWith('is waiting for the person')) return { kind: 'waiting' }
  if (rest.startsWith('stopped: its session ended.')) return { kind: 'stopped' }
  if (rest.startsWith('ended its turn without finishing')) return { kind: 'failed' }
  if (rest.startsWith('failed: ')) {
    const reason = /^failed: (.*?)(?= \((?:subagentId|workspaceId) "| Read (?:it|where it stands) with |$)/su.exec(rest)
    return { kind: 'failed', ...(reason?.[1]?.trim() ? { reason: reason[1].trim() } : {}) }
  }
  return null
}

// The reply is the last thing the notice says, between `<<` and `>>`. Studio
// takes both marks out of what it quotes, so the first `<<` after the framing
// opens it and the last `>>` closes it.
function quotedReply(rest: string): string | undefined {
  const framing = rest.indexOf(QUOTED)
  if (framing < 0) return undefined
  const open = rest.indexOf('<<', framing)
  const close = rest.lastIndexOf('>>')
  if (open < 0 || close <= open || rest.slice(close + 2).trim()) return undefined
  return rest.slice(open + 2, close).trim() || undefined
}

const HAPPENED: Record<ConversationAgentNoticeKind, string> = {
  finished: 'finished',
  failed: 'failed',
  waiting: 'is waiting for you',
  stopped: 'stopped',
}

/** A notice's row in words: "Sub-agent Reviewer finished". */
export function agentNoticeTitle(notice: ConversationAgentNotice): string {
  return `${notice.subagent ? 'Sub-agent' : 'Agent'} ${notice.name} ${HAPPENED[notice.kind]}`
}
