import {
  CONVERSATION_HIGHLIGHT_COLORS,
  isConversationHighlightColor,
  type ConversationHighlightColor,
  type ConversationSearchHit,
} from './conversation.js'
import {
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioParsed,
} from './contract.js'
import { STUDIO_CHAT_LIFECYCLE_CAPABILITY } from './handshake.js'

// A chat's record on the Studio it lives on, beyond its rest and visit clock
// (`conversation.settle`, `conversation.visit`): its row menu's marks, its
// name, its Auto compact, deleting it once settled, and a search of what was
// said in every chat. What the desktop's own sidebar, palette and Settings do
// to a chat there, a phone or another desktop does here, and every device
// that lists the chat reads the same record.
//
// Each addresses a chat by its workspace, as `conversation.settle` does: the
// record is the workspace's, one chat on the Studio. Every change carries a command id: a retry after a
// dropped connection is answered with the first answer and written once, so a
// mark retried after someone changed it since does not undo that change.
// Changing needs `conversation:operate`; the delete plan and the search are
// reads (`conversation:read`). All are offered by `chat-lifecycle`.

type Chat = { workspaceId: string }
type Commanded = Chat & { commandId: string }

/** The longest name a chat takes: far more than any list shows. */
export const STUDIO_CHAT_NAME_MAX_CHARS = 500
/** A search is two characters at least, and no longer than a palette question. */
export const STUDIO_CHAT_SEARCH_MIN_CHARS = 2
export const STUDIO_CHAT_SEARCH_MAX_CHARS = 200

/** Why a worktree stays when its chat is deleted. */
export type StudioChatWorktreeKeptBecause = 'changes' | 'shared' | 'not-made-here' | 'other-machine' | 'unreadable'

/** One worktree a settled chat owns, as its delete would treat it; never its path. */
export type StudioChatDeleteWorktree = {
  /** The folder's own name. */
  name: string
  branch: string | null
  /** A worktree pool slot: it goes back to the pool rather than off the disk. */
  pooled: boolean
  /** Changed, staged and untracked paths; null when not read. */
  changedPaths: number | null
  /** Commits only this worktree has; null when not read. */
  unpushedCommits: number | null
  fate: 'remove' | 'keep'
  keptBecause?: StudioChatWorktreeKeptBecause
}

/** What deleting a chat would do now. `gone`: there is no such chat any more. */
export type StudioChatDeletePlan = {
  gone?: true
  worktrees: StudioChatDeleteWorktree[]
  /** Why it cannot be deleted now (not settled, an agent at work). Absent when it can. */
  refused?: string
}

/** What a delete did with each worktree the chat owned. */
export type StudioChatDeletedWorktree = {
  name: string
  branch: string | null
  /** `removed`: off the disk; `returned`: back in the pool; `kept`: still there. */
  result: 'removed' | 'returned' | 'kept'
  /** Why it was kept, in a sentence. */
  detail?: string
}

/** A delete done. `gone`: the chat was already gone, as asked. */
export type StudioChatDeleted = { gone?: true; worktrees: StudioChatDeletedWorktree[] }

/** One chat with words that match, and the best of its matches. */
export type StudioChatSearchChat = {
  workspaceId: string
  chatTitle: string
  hits: ConversationSearchHit[]
  /** Every match the chat has, of which `hits` are the first. */
  count: number
}

/** What the chats the Studio lists say that matches, most recently spoken in first. */
export type StudioChatSearchAnswer = {
  chats: StudioChatSearchChat[]
  /** The answer stopped early, at its limit or its time; a narrower question finds the rest. */
  truncated: boolean
}

export type StudioChatLifecycleMethodMap = {
  /**
   * Mark the chat unread on every device: its visit clock moves back to just
   * before its latest finish. Refused `conflict` when no agent in it has
   * finished anything.
   */
  'conversation.markUnread': {
    params: Commanded
    result: { lastVisitedAt: number }
    errors: 'not_found' | 'conflict'
  }
  /**
   * Snooze the chat until `until` (epoch ms, still ahead), or wake it now
   * with null. Refused `conflict` while an agent in it works, or for a
   * settled chat.
   */
  'conversation.snooze': {
    params: Commanded & { until: number | null }
    result: { snoozedUntil: number | null }
    errors: 'not_found' | 'conflict'
  }
  /** Star it and pick its highlight colour (null takes it off); a member left out stays as it is. */
  'conversation.highlight': {
    params: Commanded & { starred?: boolean; color?: ConversationHighlightColor | null }
    result: { starred: boolean; color: ConversationHighlightColor | null }
    errors: 'not_found'
  }
  /** Its Auto-settle: the rest sweep settles it once quiet. */
  'conversation.setAutoSettle': {
    params: Commanded & { enabled: boolean }
    result: { enabled: boolean }
    errors: 'not_found'
  }
  /** Its Auto compact: compacted by itself while idle, whatever the Studio's default. */
  'conversation.setAutoCompact': {
    params: Commanded & { enabled: boolean }
    result: { enabled: boolean }
    errors: 'not_found'
  }
  /** The name every device lists it by, kept from then on. */
  'conversation.rename': {
    params: Commanded & { name: string }
    result: { name: string }
    errors: 'not_found'
  }
  /** What deleting the settled chat would do now. Changes nothing. */
  'conversation.deletePlan': {
    params: Chat
    result: StudioChatDeletePlan
  }
  /**
   * Delete the settled chat for good: its history, its record and the
   * worktrees it owns (never one with changes). Refused `conflict` while it
   * is not settled or an agent in it works.
   */
  'conversation.delete': {
    params: Commanded
    result: StudioChatDeleted
    errors: 'conflict'
  }
  /** What was said in the chats the Studio lists, as its own palette finds it. */
  'conversation.searchChats': {
    params: { query: string }
    result: StudioChatSearchAnswer
  }
}

export type StudioChatLifecycleMethod = keyof StudioChatLifecycleMethodMap

const WORKSPACE_ID = '"workspaceId" names the chat\'s workspace, as the conversation list gives it.'
const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

type Held = Pick<StudioMethodDefinition<never>, 'scope' | 'mutation' | 'capability'>
const reading: Held = { scope: 'conversation:read', mutation: false, capability: STUDIO_CHAT_LIFECYCLE_CAPABILITY }
const operating: Held = { scope: 'conversation:operate', mutation: true, capability: STUDIO_CHAT_LIFECYCLE_CAPABILITY }

function chat(value: Record<string, unknown>): StudioParsed<Chat> {
  return typeof value.workspaceId === 'string' && value.workspaceId && value.workspaceId.length <= 200
    ? studioParams({ workspaceId: value.workspaceId })
    : refuse(WORKSPACE_ID)
}

function commanded(value: Record<string, unknown>): StudioParsed<Commanded> {
  const at = chat(value)
  if (!at.ok) return at
  if (typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 200) return refuse(COMMAND_ID)
  return studioParams({ ...at.params, commandId: value.commandId })
}

/** A command with one more member, read by `read`. */
function withMember<T extends object>(
  read: (value: Record<string, unknown>) => StudioParsed<T>,
): (value: Record<string, unknown>) => StudioParsed<Commanded & T> {
  return (value) => {
    const at = commanded(value)
    if (!at.ok) return at
    const rest = read(value)
    return rest.ok ? studioParams({ ...at.params, ...rest.params }) : rest
  }
}

const switched = withMember((value) =>
  typeof value.enabled === 'boolean' ? studioParams({ enabled: value.enabled }) : refuse('"enabled" is true or false.'),
)

export const STUDIO_CHAT_LIFECYCLE_METHODS: StudioMethodTable<StudioChatLifecycleMethodMap> = {
  'conversation.markUnread': { ...operating, params: commanded },
  'conversation.snooze': {
    ...operating,
    params: withMember((value) =>
      value.until === null || (typeof value.until === 'number' && Number.isSafeInteger(value.until) && value.until > 0)
        ? studioParams({ until: value.until as number | null })
        : refuse('"until" is when it wakes, in epoch milliseconds, or null to wake it now.'),
    ),
  },
  'conversation.highlight': {
    ...operating,
    params: withMember((value) => {
      if (value.starred !== undefined && typeof value.starred !== 'boolean')
        return refuse('"starred" is true or false.')
      if (value.color !== undefined && value.color !== null && !isConversationHighlightColor(value.color))
        return refuse(`"color" is one of ${CONVERSATION_HIGHLIGHT_COLORS.join(', ')}, or null.`)
      if (value.starred === undefined && value.color === undefined) return refuse('Say "starred", "color" or both.')
      return studioParams({
        ...(value.starred !== undefined ? { starred: value.starred as boolean } : {}),
        ...(value.color !== undefined ? { color: value.color as ConversationHighlightColor | null } : {}),
      })
    }),
  },
  'conversation.setAutoSettle': { ...operating, params: switched },
  'conversation.setAutoCompact': { ...operating, params: switched },
  'conversation.rename': {
    ...operating,
    params: withMember((value) => {
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      return name && name.length <= STUDIO_CHAT_NAME_MAX_CHARS
        ? studioParams({ name })
        : refuse(`"name" is the chat's name, 1 to ${STUDIO_CHAT_NAME_MAX_CHARS} characters.`)
    }),
  },
  'conversation.deletePlan': { ...reading, params: chat },
  'conversation.delete': { ...operating, params: commanded },
  'conversation.searchChats': {
    ...reading,
    params: (value) => {
      const query = typeof value.query === 'string' ? value.query.trim() : ''
      return query.length >= STUDIO_CHAT_SEARCH_MIN_CHARS && query.length <= STUDIO_CHAT_SEARCH_MAX_CHARS
        ? studioParams({ query })
        : refuse(
            `"query" is what to find, ${STUDIO_CHAT_SEARCH_MIN_CHARS} to ${STUDIO_CHAT_SEARCH_MAX_CHARS} characters.`,
          )
    },
  },
}
