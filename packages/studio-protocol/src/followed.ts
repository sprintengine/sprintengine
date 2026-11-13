import {
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import {
  CONVERSATION_MAX_FILE_SEARCH_QUERY_CHARS,
  CONVERSATION_MAX_FILE_SEARCH_RESULTS,
  CONVERSATION_MAX_SIDE_QUESTION_HISTORY,
  isConversationChangedPath,
  parseConversationChangesSelection,
  parseConversationSideQuestionRequest,
  type ConversationChangedFileSides,
  type ConversationChangesDiff,
  type ConversationChangesFrame,
  type ConversationChangesSelection,
  type ConversationCommandsAnswer,
  type ConversationContextBreakdownResult,
  type ConversationFileSearchAnswer,
  type ConversationQueuedFrame,
  type ConversationScheduledFrame,
  type ConversationSideQuestionExchange,
  type ConversationSideQuestionResult,
  type ConversationSubagentsFrame,
  type ConversationUsageLimitsFrame,
} from './conversation.js'
import { STUDIO_CONVERSATIONS_CAPABILITY } from './handshake.js'
import { parseStudioConversationKey, type StudioConversationKey } from './key.js'

// What a follower of one chat reads and does beside its stream, by the chat's
// key: what the tailnet lane served a paired device on its socket and its
// routes, so that nothing a chat offers exists only there. Each calls the same
// conversation host the lane does.
//
// Every one is offered by the conversation capability the lane names it by
// (`conversation-side-questions`, `conversation-changes`, …), which a Studio
// lists in its welcome's `conversation.capabilities`, and is held by the
// Studio capability every keyed conversation method is (`conversations`).
// Reading needs `conversation:read`; what runs the chat's agent or writes the
// chat's record needs `conversation:operate`. Asking whether a grant reaches
// one is `studioGrantAllows`, as for any method.
//
// The per-chat topics push the lane's own frames, whole each time, `key`
// included: told what stands on subscribing, and again whenever it reads
// differently. A client that comes back subscribes again and is told afresh.

type Keyed = { key: StudioConversationKey }

export type StudioFollowedMethodMap = {
  /**
   * A side question about the chat, asked of its agent under the client's own
   * `questionId` and added to nothing (`conversation-side-questions`); a chat
   * at rest is resumed for it, as a send resumes one. Kept in the chat's
   * transcript once answered (`conversation-side-question-records`). Refused
   * in its answer for a chat whose provider cannot (`capabilities.sideQuestion`),
   * and `cancelled` when called off.
   */
  'conversation.askSideQuestion': {
    params: Keyed & {
      commandId: string
      questionId: string
      question: string
      history?: ConversationSideQuestionExchange[]
    }
    result: ConversationSideQuestionResult
    errors: 'not_found'
  }
  /** Call off a side question this client asked that is still being answered. Another client's is passed over. */
  'conversation.cancelSideQuestion': {
    params: { questionId: string }
    result: { ok: true } | { ok: false; message: string }
  }
  /**
   * What fills the chat's context window, as its live agent measures it
   * (`conversation-context-breakdown`). A chat with no live session is not
   * started for it.
   */
  'conversation.contextBreakdown': {
    params: Keyed
    result: ConversationContextBreakdownResult
    errors: 'not_found'
  }
  /**
   * The files and folders in the chat's folder whose names match `query`,
   * best first, each by its path relative to that folder
   * (`conversation-file-search`): what an @ mention names. Nothing outside the
   * folder is named, and the client names the chat, never a folder. A
   * client's next search supersedes its last.
   */
  'conversation.searchFiles': {
    params: Keyed & { query: string; limit?: number }
    result: ConversationFileSearchAnswer
    errors: 'not_found'
  }
  /**
   * The slash commands the chat's CLI runs in the chat's folder
   * (`conversation-commands`). `refresh` asks the CLI again now, which starts
   * it, and so needs `conversation:operate` as well.
   */
  'conversation.listCommands': {
    params: Keyed & { refresh?: boolean }
    result: ConversationCommandsAnswer
    errors: 'not_found'
  }
  /**
   * Settle the chat, as its row menu's Settle does (`conversation-lifecycle`):
   * it leaves the list, its agents' processes end, and the next message
   * resumes it. `settled: false` brings it back. Refused `conflict` while an
   * agent in it works. Settling a settled chat changes nothing. Addressed by
   * the chat's workspace, whose record its rest is (`chat-lifecycle.ts`).
   */
  'conversation.settle': {
    params: { workspaceId: string; commandId: string; settled?: boolean }
    result: { settledAt: number | null }
    errors: 'not_found' | 'conflict'
  }
  /**
   * The person has the chat on screen: its "finished, unseen" mark clears on
   * every device (`conversation-lifecycle`). Moves its `lastVisitedAt`
   * forward to `visitedAt` (now when absent, never past now); an earlier time
   * changes nothing, so it carries no command id and is safe to send again.
   * Addressed by the chat's workspace, as a settle is.
   */
  'conversation.visit': {
    params: { workspaceId: string; visitedAt?: number }
    result: { lastVisitedAt: number }
    errors: 'not_found'
  }
  /** One step of the chat's changes: its files (`conversation-changes`). */
  'conversation.changesDiff': {
    params: Keyed & { selection: ConversationChangesSelection }
    result: ConversationChangesDiff
    errors: 'not_found'
  }
  /**
   * Both sides of one file a step of the chat's changes lists, by its path in
   * the checkout as the step names it. A path the step does not list is
   * `not_found`, so nothing outside the change is readable.
   */
  'conversation.changedFile': {
    params: Keyed & { selection: ConversationChangesSelection; path: string }
    result: ConversationChangedFileSides
    errors: 'not_found'
  }
}

/** The per-chat topics: each pushes the lane's own frame of that kind, whole. */
export type StudioFollowedTopicMap = {
  /** What the Studio holds for the chat's turn to end (`conversation-queued-sends`). */
  'conversation.queued': { params: Keyed; payload: ConversationQueuedFrame; stream: 'push' }
  /** What it has scheduled into the chat for a time (`conversation-scheduled-sends`). */
  'conversation.scheduled': { params: Keyed; payload: ConversationScheduledFrame; stream: 'push' }
  /** What it knows of its agents' usage limits, for the chat (`conversation-usage-limits`). */
  'conversation.usageLimits': { params: Keyed; payload: ConversationUsageLimitsFrame; stream: 'push' }
  /** Which sub-agents the chat has and how each stands (`conversation-subagents`). */
  'conversation.subagents': { params: Keyed; payload: ConversationSubagentsFrame; stream: 'push' }
  /** How the chat's checkout stands, as its Diff tab reads it (`conversation-changes`). */
  'conversation.changes': { params: Keyed; payload: ConversationChangesFrame; stream: 'push' }
}

export type StudioFollowedTopic = keyof StudioFollowedTopicMap

type Held = Pick<StudioMethodDefinition<never>, 'scope' | 'mutation' | 'capability' | 'extraPermissions'>
const reading: Held = { scope: 'conversation:read', mutation: false, capability: STUDIO_CONVERSATIONS_CAPABILITY }
const operating: Held = { scope: 'conversation:operate', mutation: true, capability: STUDIO_CONVERSATIONS_CAPABILITY }

const KEY = '"key" names the conversation: { workspaceId, agentId, workspaceRoot? }.'
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'
const WORKSPACE_ID = '"workspaceId" names the chat\'s workspace, as the conversation list gives it.'
const QUESTION_ID = '"questionId" must be a string of 1 to 200 characters.'
const SELECTION = '"selection" is { kind: "span" }, { kind: "uncommitted" } or { kind: "commit", hash }.'

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A chat by its workspace, whose record its rest and visit clock are. */
function workspace(value: Record<string, unknown>): StudioParsed<{ workspaceId: string }> {
  return id(value.workspaceId) ? studioParams({ workspaceId: value.workspaceId }) : refuse(WORKSPACE_ID)
}

function keyed(value: Record<string, unknown>): StudioParsed<Keyed> {
  const key = parseStudioConversationKey(value.key)
  return key ? studioParams({ key }) : refuse(KEY)
}

function selected(value: Record<string, unknown>): StudioParsed<Keyed & { selection: ConversationChangesSelection }> {
  const at = keyed(value)
  if (!at.ok) return at
  const selection = parseConversationChangesSelection(value.selection)
  return selection ? studioParams({ ...at.params, selection }) : refuse(SELECTION)
}

export const STUDIO_FOLLOWED_METHODS: StudioMethodTable<StudioFollowedMethodMap> = {
  // It runs the chat's agent, as a send does, and a retry under its command
  // id is answered with the first answer.
  'conversation.askSideQuestion': {
    ...operating,
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (!id(value.questionId)) return refuse(QUESTION_ID)
      // The lane's own validator: the same question is refused on both.
      const read = parseConversationSideQuestionRequest({
        type: 'askSideQuestion',
        requestId: value.questionId,
        questionId: value.questionId,
        question: value.question,
        ...(value.history === undefined ? {} : { history: value.history }),
      })
      if (!read || read.type !== 'askSideQuestion')
        return refuse(
          `A side question is { question, history? }: a question with words in it and at most ${CONVERSATION_MAX_SIDE_QUESTION_HISTORY} earlier { question, answer }, within a message's length.`,
        )
      return studioParams({
        ...at.params,
        commandId: value.commandId,
        questionId: read.questionId,
        question: read.question,
        ...(read.history ? { history: read.history } : {}),
      })
    },
  },
  // A client calls off only a question it asked, which a grant narrowed since
  // may still do: it reads as following the chat does.
  'conversation.cancelSideQuestion': {
    ...reading,
    params: (value) => (id(value.questionId) ? studioParams({ questionId: value.questionId }) : refuse(QUESTION_ID)),
  },
  'conversation.contextBreakdown': { ...reading, params: keyed },
  'conversation.searchFiles': {
    ...reading,
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (typeof value.query !== 'string' || value.query.length > CONVERSATION_MAX_FILE_SEARCH_QUERY_CHARS)
        return refuse(
          `"query" is the name searched for, at most ${CONVERSATION_MAX_FILE_SEARCH_QUERY_CHARS} characters.`,
        )
      const limit = value.limit
      if (
        limit !== undefined &&
        !(
          typeof limit === 'number' &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= CONVERSATION_MAX_FILE_SEARCH_RESULTS
        )
      )
        return refuse(`"limit" is between 1 and ${CONVERSATION_MAX_FILE_SEARCH_RESULTS}.`)
      return studioParams({ ...at.params, query: value.query.trim(), ...(limit === undefined ? {} : { limit }) })
    },
  },
  // A refresh starts the CLI to ask it again: the router holds it to a grant
  // that may operate the chat, as the lane's route did.
  'conversation.listCommands': {
    ...reading,
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (value.refresh !== undefined && typeof value.refresh !== 'boolean')
        return refuse('"refresh" is true or false.')
      return studioParams({ ...at.params, ...(value.refresh === true ? { refresh: true } : {}) })
    },
  },
  'conversation.settle': {
    ...operating,
    params: (value) => {
      const at = workspace(value)
      if (!at.ok) return at
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (value.settled !== undefined && typeof value.settled !== 'boolean')
        return refuse('"settled" is true or false.')
      return studioParams({
        ...at.params,
        commandId: value.commandId,
        ...(value.settled === undefined ? {} : { settled: value.settled }),
      })
    },
  },
  // Stamped every few seconds while a chat is on screen, and idempotent by
  // its time: no command id, and not audited.
  'conversation.visit': {
    ...operating,
    mutation: false,
    params: (value) => {
      const at = workspace(value)
      if (!at.ok) return at
      const { visitedAt } = value
      if (visitedAt === undefined) return at
      if (!(typeof visitedAt === 'number' && Number.isFinite(visitedAt) && visitedAt >= 0))
        return refuse('"visitedAt" is a time in epoch milliseconds.')
      return studioParams({ ...at.params, visitedAt: Math.trunc(visitedAt) })
    },
  },
  'conversation.changesDiff': { ...reading, params: selected },
  'conversation.changedFile': {
    ...reading,
    params: (value) => {
      const at = selected(value)
      if (!at.ok) return at
      return isConversationChangedPath(value.path)
        ? studioParams({ ...at.params, path: value.path })
        : refuse('"path" is a file of the step, relative to the checkout.')
    },
  },
}

const followed = {
  scope: 'conversation:read',
  capability: STUDIO_CONVERSATIONS_CAPABILITY,
  push: true,
  params: keyed,
} as const

export const STUDIO_FOLLOWED_TOPICS: StudioTopicTable<StudioFollowedTopicMap> = {
  'conversation.queued': followed,
  'conversation.scheduled': followed,
  'conversation.usageLimits': followed,
  'conversation.subagents': followed,
  'conversation.changes': followed,
}
