import type { ConversationMessageOrigin, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { usageLimitProviderOfConversation, type UsageLimitProvider } from '../../shared/usage-limits'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { ConversationGatewayHost } from './conversation-host'
import { usageRateLimit, type UsageRateLimitAnswer } from '../../main/usage-limits/store'
import type { PullRequestDomainOptions } from '../pull-requests/pull-request-domain'

// The Studio core's pull request wakes (pull-requests/pull-request-wakes.ts),
// wired to what the core holds: its chats, the registry's records, the usage
// limits, and a conversation host whose sends are Studio's own. Kept apart
// from the core's composition so the wiring is tested as the core builds it.
//
// A chat is its agent in its workspace's record, and its wake goes to the
// folder the record names. Every Studio holds a record of every chat it runs:
// an SSH machine's and a WSL distribution's too, since their chats live there
// (design-environments). The one gap is a chat whose record the desktop has
// not handed over yet: while it runs here, its news waits for the record,
// which comes with the desktop's next connection. A workspace the registry
// removed is gone, whatever the runtime still holds.

/** The client a wake is sent as, for the runtime's command receipts. */
export const STUDIO_PULL_REQUEST_WATCH_CLIENT_ID = 'studio-pull-request-watch'

/** How a chat records a wake: Studio's, about a pull request its agent asked Studio to watch. */
export const PULL_REQUEST_WATCH_ORIGIN: ConversationMessageOrigin = { kind: 'studio', reason: 'pull-request-watch' }

export type StudioPullRequestWakesDeps = {
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
  }
  /** A workspace's record: whether it is settled, and the agents (chats) it holds. */
  workspaceRecord: (workspaceId: string) => { settledAt?: number | null; agents: Record<string, unknown> } | null
  /** Whether the registry removed the workspace: a chat in it is gone, whatever the runtime still holds. */
  workspaceRemoved?: (workspaceId: string) => boolean
  /** A conversation host whose sends carry `origin` and stamp no one's message clock. */
  createHost: (options: {
    origin: ConversationMessageOrigin
  }) => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  /** The usage limits; the app's one store unless a test hands its own. */
  rateLimit?: (provider: UsageLimitProvider, now: number) => UsageRateLimitAnswer
  log?: (message: string) => void
}

export function studioPullRequestWakes(
  deps: StudioPullRequestWakesDeps,
): NonNullable<PullRequestDomainOptions['wakes']> {
  const rateLimit = deps.rateLimit ?? ((provider: UsageLimitProvider, now: number) => usageRateLimit(provider, now))
  let host: ReturnType<StudioPullRequestWakesDeps['createHost']> | null = null
  const sessions = () => {
    const listed = deps.conversations.listSessions()
    return listed.ok ? listed.sessions : []
  }
  return {
    listSessions: sessions,
    // A chat is its agent in its workspace's record; a settled workspace is
    // one the person put away. A chat this server runs with no record here
    // yet waits for it; with neither, it is gone.
    chat: (key) => {
      const record = deps.workspaceRecord(key.workspaceId)
      if (record) return Object.hasOwn(record.agents, key.agentId) ? { settled: isSettledWorkspace(record) } : null
      if (deps.workspaceRemoved?.(key.workspaceId)) return null
      const runs = sessions().some(
        (session) => session.workspaceId === key.workspaceId && session.agentId === key.agentId,
      )
      return runs ? 'pending' : null
    },
    // Through the same send a paired device's goes, which resumes a chat with
    // no live session from its transcript, marked as Studio's.
    send: async (chat, text, commandId) => {
      host ??= deps.createHost({ origin: PULL_REQUEST_WATCH_ORIGIN })
      const key = host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      return host.command(key, STUDIO_PULL_REQUEST_WATCH_CLIENT_ID, commandId, { kind: 'send', message: text })
    },
    usageLimit: (providerId) => {
      const provider = usageLimitProviderOfConversation(providerId)
      return provider ? rateLimit(provider, Date.now()) : { limited: false, resetsAt: null }
    },
    ...(deps.log ? { log: deps.log } : {}),
  }
}
