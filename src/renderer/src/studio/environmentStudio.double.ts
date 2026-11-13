import {
  StudioError,
  type ConversationFollowFrame,
  type ConversationFollowOptions,
  type StudioClient,
  type StudioClientState,
} from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioScope,
} from '../../../../packages/studio-protocol/src/public'
import { parseEnvironmentRoute } from '../../../../packages/studio-protocol/src/environment'
import { followEnvironmentChats } from './environmentChats'
import { closeEnvironmentStudios, configureEnvironmentStudio } from './environmentStudio'

// A stand-in for each paired machine's Studio as this window's own client
// reaches it (`environmentStudio.ts`), for tests of what asks it. A test gives its
// `window.api` one:
//
//   const studio = fakePairedStudios(window.api, {
//     'workspaces.list': () => ({ workspaces: [...] }),
//     'conversation.settle': (params) => ({ settledAt: 1 }),
//   })
//
// and reads `studio.calls`, or `studio.writes()` for the changes alone. A method it names no answer for is refused
// `unknown_method`, as a Studio without it would. Each machine serves the
// capabilities and holds the scopes given, or all of them, and serves its chats
// the conversation capabilities given, or none.
//
// A chat followed there (`client.conversations.follow`) is in `follows`, and a
// test plays what that machine sends it with `frame`; its reads
// (`loadEarlier`, `toolDetail`, `event`, `turnDiff`) are asked as their methods
// (`conversation.turnDiff`, …), answered by `answers` like any other. A push
// topic hears `push`; `setState` moves a machine's connection as a drop and a
// reconnect would.

/** What one method answers, given what it was asked and which machine was asked. */
type Answer = (params: Record<string, unknown>, connectionId: string) => unknown

export type PairedStudiosDouble = {
  /** Every ask, in order. */
  calls: Array<{ connectionId: string; method: string; params: Record<string, unknown> }>
  /** The answers, changeable as the test goes. */
  answers: Record<string, Answer>
  /** The capabilities each machine serves; change to make one older. */
  capabilities: Set<string>
  /** The conversation capabilities its chats are served with (the welcome's `conversation.capabilities`). */
  conversationCapabilities: Set<string>
  /** What the pairing may do there. */
  scopes: StudioScope[]
  /** Refuse a machine's connection, as a ticket refused or a machine away does; null connects. */
  refuse: (connectionId: string) => StudioError | null
  /** The changes asked, reads left out, each without its command id. */
  writes(): Array<{ connectionId: string; method: string; params: Record<string, unknown> }>
  /**
   * Push a topic's payload to every client of the machines that follows it;
   * given a chat, only to those following it for that chat (`params.key`).
   */
  push(topic: string, payload: unknown, chat?: { workspaceId: string; agentId: string }): void
  /** Every chat followed, in the order followed, each with whether it is still followed. */
  follows: Array<{
    connectionId: string
    ref: { workspaceId: string; agentId: string }
    options: ConversationFollowOptions | undefined
    open: boolean
  }>
  /**
   * Play a frame of a followed chat as that machine sends it: to the chat most
   * recently followed and still followed, or to the newest follow of `agentId`.
   */
  frame(frame: ConversationFollowFrame | { type: 'error'; message: string }, agentId?: string): void
  /** Move a machine's connection, as a drop (`reconnecting`) and its return (`open`) do. */
  setState(connectionId: string, state: StudioClientState): void
}

/** The methods that only read, which `writes` leaves out. */
const READS = new Set([
  'session.list',
  'conversation.list',
  'workspaces.list',
  'workspaces.checkout',
  'workspaces.extensions',
  'cliRuntimes.list',
  'schedules.list',
  'conversation.deletePlan',
  'conversation.searchChats',
  'conversation.approvalRules',
  'canvas.list',
  'canvas.picture',
  'canvas.read',
  'canvas.files',
])

const ALL_CAPABILITIES = [
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
]

const ALL_SCOPES: StudioScope[] = [
  'workspaces:read',
  'workspaces:operate',
  'conversation:read',
  'conversation:operate',
  'conversation:create',
]

/** A read a chat's follow makes, answered as its method's result or refused as `ConversationResult`. */
async function result(ask: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: true, ...((await ask()) as object) }
  } catch (error) {
    if (error instanceof StudioError) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

export function fakePairedStudios(
  api: object,
  answers: Record<string, Answer> = {},
  options: {
    capabilities?: readonly string[]
    conversationCapabilities?: readonly string[]
    scopes?: StudioScope[]
  } = {},
): PairedStudiosDouble {
  const followers = new Map<string, Set<{ params: unknown; listener: (payload: unknown) => void }>>()
  const receivers: Array<{
    agentId: string
    receive: (frame: ConversationFollowFrame | { type: 'error'; message: string }) => void
    entry: PairedStudiosDouble['follows'][number]
  }> = []
  const states = new Map<string, { state: StudioClientState; tell: (state: StudioClientState) => void }>()
  const sameChat = (params: unknown, chat: { workspaceId: string; agentId: string }) => {
    const key = (params as { key?: { workspaceId?: unknown; agentId?: unknown } } | null)?.key
    return key?.workspaceId === chat.workspaceId && key.agentId === chat.agentId
  }
  const double: PairedStudiosDouble = {
    push: (topic, payload, chat) => {
      for (const { params, listener } of [...(followers.get(topic) ?? [])])
        if (!chat || sameChat(params, chat)) listener(payload)
    },
    follows: [],
    frame: (frame, agentId) => {
      const to = receivers.filter((entry) => entry.entry.open && (agentId === undefined || entry.agentId === agentId))
      const receiver = to.at(-1)
      if (!receiver) throw new Error(`No chat${agentId ? ` ${agentId}` : ''} is followed.`)
      receiver.receive(frame)
    },
    setState: (connectionId, state) => {
      const known = states.get(connectionId)
      if (!known) throw new Error(`No client of ${connectionId} is open.`)
      known.state = state
      known.tell(state)
    },
    calls: [],
    answers: { ...answers },
    capabilities: new Set(options.capabilities ?? ALL_CAPABILITIES),
    conversationCapabilities: new Set(options.conversationCapabilities ?? []),
    scopes: options.scopes ?? ALL_SCOPES,
    refuse: () => null,
    writes: () =>
      double.calls
        .filter((call) => !READS.has(call.method))
        .map(({ connectionId, method, params: { commandId: _commandId, ...params } }) => ({
          connectionId,
          method,
          params,
        })),
  }
  // A window's chat sources are its own: one a test before followed is let go with its client.
  followEnvironmentChats([])
  closeEnvironmentStudios(api as never)
  configureEnvironmentStudio(api, {
    connect: async (route, tell) => {
      // A paired machine is asked by its pairing; any other route by its whole name.
      const parsed = parseEnvironmentRoute(route)
      const connectionId = parsed?.kind === 'tailnet' ? parsed.connection : route
      const refused = double.refuse(connectionId)
      if (refused) throw refused
      const ask = async (method: string, params: Record<string, unknown> = {}) => {
        double.calls.push({ connectionId, method, params })
        const answer = double.answers[method]
        if (!answer) throw new StudioError('unknown_method', `This Studio does not serve ${method}.`)
        return answer(params, connectionId)
      }
      const sayWelcome = () => ({
        environment: { id: `env-${connectionId}` },
        capabilities: [...double.capabilities],
        conversation: { protocolVersion: 1, minProtocolVersion: 1, capabilities: [...double.conversationCapabilities] },
        grant: {
          clientId: 'tailnet:double',
          name: 'dev-macbook-air',
          owner: false,
          scopes: double.scopes,
          ceiling: 'bypass',
        },
      })
      let said: { as: string; welcome: ReturnType<typeof sayWelcome> } | null = null
      const welcome = (): ReturnType<typeof sayWelcome> => {
        const as = JSON.stringify([[...double.capabilities], [...double.conversationCapabilities], double.scopes])
        if (said?.as !== as) said = { as, welcome: sayWelcome() }
        return said.welcome
      }
      const state = { state: 'open' as StudioClientState, tell }
      states.set(connectionId, state)
      const ref = (given: { workspaceId: string; agentId: string }) => ({
        workspaceId: given.workspaceId,
        agentId: given.agentId,
      })
      const client = {
        get state() {
          return state.state
        },
        get grant() {
          return welcome().grant
        },
        // What that machine's Studio said of itself: what a chat there may do is read off it.
        // The same welcome until the test changes what it serves, as a client's is until it reconnects.
        get welcome() {
          return welcome()
        },
        supports: (capability: string) => double.capabilities.has(capability),
        // A topic followed here hears what the test pushes (`push`).
        subscribe: (topic: string, params: unknown, handlers: { onPayload?: (payload: unknown) => void }) => {
          const follower = { params, listener: (payload: unknown) => handlers.onPayload?.(payload) }
          const set = followers.get(topic) ?? new Set()
          set.add(follower)
          followers.set(topic, set)
          return () => set.delete(follower)
        },
        // A chat followed there: the test plays its frames (`frame`).
        conversations: {
          follow: (
            given: { workspaceId: string; agentId: string },
            followOptions: ConversationFollowOptions | undefined,
            onFrame: (frame: ConversationFollowFrame | { type: 'error'; message: string }) => void,
          ) => {
            const entry = { connectionId, ref: ref(given), options: followOptions, open: true }
            double.follows.push(entry)
            receivers.push({ agentId: given.agentId, receive: (frame) => entry.open && onFrame(frame), entry })
            return () => {
              entry.open = false
            }
          },
          loadEarlier: (given: { workspaceId: string; agentId: string }, beforeCursor: number, turnLimit?: number) =>
            result(() =>
              ask('conversation.loadEarlier', {
                key: ref(given),
                beforeCursor,
                ...(turnLimit === undefined ? {} : { turnLimit }),
              }),
            ),
          toolDetail: (given: { workspaceId: string; agentId: string }, toolUseId: string) =>
            result(() => ask('conversation.toolDetail', { key: ref(given), toolUseId })),
          event: (given: { workspaceId: string; agentId: string }, seq: number, id: string) =>
            result(() => ask('conversation.event', { key: ref(given), seq, id })),
          turnDiff: (given: { workspaceId: string; agentId: string }, turnSeq: number, path?: string) =>
            result(() =>
              ask('conversation.turnDiff', { key: ref(given), turnSeq, ...(path === undefined ? {} : { path }) }),
            ),
        },
        request: ask,
        rpc: new Proxy(
          {},
          { get: (_target, method: string) => (params: Record<string, unknown>) => ask(method, params) },
        ),
        close: () => undefined,
        closed: new Promise<void>(() => undefined),
        wake: () => undefined,
      }
      return client as unknown as StudioClient
    },
  })
  return double
}
