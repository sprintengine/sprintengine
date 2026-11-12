import type { ConversationMessageOrigin, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { usageLimitProviderOfConversation, type UsageLimitProvider } from '../../shared/usage-limits'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { ConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import { usageRateLimit, type UsageRateLimitAnswer } from '../../main/usage-limits/store'
import type { PullRequestDomainOptions } from '../pull-requests/pull-request-domain'
import type { PullRequestChatFolders } from '../pull-requests/pull-request-chat-folders'
import type { PullRequestConversationKey } from '../pull-requests/pull-request-record'

// The Studio core's pull request wakes (pull-requests/pull-request-wakes.ts),
// wired to what the core holds: its chats, the registry's records, the usage
// limits, and a conversation host whose sends are Studio's own. Kept apart
// from the core's composition so the wiring is tested as the core builds it.
//
// A chat is its agent in its workspace's record where this server holds one
// (the desktop's). A WSL distribution's server and an SSH machine's hold none:
// the desktop keeps those records, and hands the folder over with every start.
// There a chat is what the runtime runs, at the folder its session works in,
// kept (pull-request-chat-folders.ts) when its agent asked for the watch, so a
// wake still finds it once the session is gone or the server restarted. A
// workspace the registry removed is gone, whatever the runtime still holds.

/** The client a wake is sent as, for the runtime's command receipts. */
export const STUDIO_PULL_REQUEST_WATCH_CLIENT_ID = 'studio-pull-request-watch'

/** How a chat records a wake: Studio's, about a pull request its agent asked Studio to watch. */
export const PULL_REQUEST_WATCH_ORIGIN: ConversationMessageOrigin = { kind: 'studio', reason: 'pull-request-watch' }

export type StudioPullRequestWakesDeps = {
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
    /** The folder a session works in; null for one not here. */
    sessionWorkspaceRoot?(sessionId: string): string | null
  }
  /** A workspace's record: whether it is settled, and the agents (chats) it holds. */
  workspaceRecord: (workspaceId: string) => { settledAt?: number | null; agents: Record<string, unknown> } | null
  /** Whether the registry removed the workspace: a chat in it is gone, whatever the runtime still holds. */
  workspaceRemoved?: (workspaceId: string) => boolean
  /** Where a watched chat this server holds no record of works. Absent, such a chat is gone. */
  chatFolders?: PullRequestChatFolders
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
  // The folder the chat's newest session here works in.
  const liveFolder = (key: PullRequestConversationKey): string | null => {
    const latest = sessions()
      .filter((session) => session.workspaceId === key.workspaceId && session.agentId === key.agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return latest ? (deps.conversations.sessionWorkspaceRoot?.(latest.sessionId) ?? null) : null
  }
  // Where a chat with no record here is: its session's folder, else the one kept for it.
  const unrecordedFolder = (key: PullRequestConversationKey): string | null => {
    if (deps.workspaceRemoved?.(key.workspaceId)) return null
    return liveFolder(key) ?? deps.chatFolders?.folderOf(key) ?? null
  }
  return {
    listSessions: sessions,
    // A chat is its agent in its workspace's record; a settled workspace is
    // one the person put away. With no record here, it is a chat this server
    // runs for a desktop that keeps the record.
    chat: (key) => {
      const record = deps.workspaceRecord(key.workspaceId)
      if (record) return Object.hasOwn(record.agents, key.agentId) ? { settled: isSettledWorkspace(record) } : null
      return unrecordedFolder(key) ? { settled: false } : null
    },
    // Through the same send a paired device's goes, which resumes a chat with
    // no live session from its transcript, marked as Studio's.
    send: async (chat, text, commandId) => {
      host ??= deps.createHost({ origin: PULL_REQUEST_WATCH_ORIGIN })
      const folder = deps.workspaceRecord(chat.workspaceId) ? null : unrecordedFolder(chat)
      const key = folder
        ? { workspaceRoot: folder, workspaceId: chat.workspaceId, agentId: chat.agentId }
        : host.resolveKey(chat.workspaceId, chat.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      return host.command(key, STUDIO_PULL_REQUEST_WATCH_CLIENT_ID, commandId, { kind: 'send', message: text })
    },
    // A watch was asked for: where this server holds no record of the chat,
    // the folder it works in now is kept for its wakes.
    remember: (key) => {
      if (deps.workspaceRecord(key.workspaceId) || deps.workspaceRemoved?.(key.workspaceId)) return
      const folder = liveFolder(key)
      if (folder) deps.chatFolders?.remember(key, folder)
    },
    retain: (keys) => deps.chatFolders?.retain(keys),
    flushFolders: () => deps.chatFolders?.flush() ?? Promise.resolve(),
    usageLimit: (providerId) => {
      const provider = usageLimitProviderOfConversation(providerId)
      return provider ? rateLimit(provider, Date.now()) : { limited: false, resetsAt: null }
    },
    ...(deps.log ? { log: deps.log } : {}),
  }
}
