import type { StudioMethod, StudioTopic } from '../../packages/studio-protocol/src/public'
import type { ServerIpcChannelName } from './ipc-channel-owners'

// Every channel the conversation IPC registers, with the Studio protocol
// methods and topics that do the same for any client, and what still keeps
// the protocol from doing it for every client as the IPC does for a window.
//
// The window reaches a chat over IPC and every other client over the Studio
// protocol, so a feature that exists only on a channel works in a local chat
// and is missing everywhere else. This table is the boundary between the two:
// its test (`src/main/ipc/conversation-ipc-protocol.test.ts`) holds it to the
// channels `registerConversationIpc` registers, both ways, so a new
// conversation channel cannot be added without saying how a client on the
// protocol does the same. Moving the window onto the protocol deletes channels
// from it, and the IPC is gone when it is empty. What a window reaches through
// its chat services (`windowChatServices`: sessions, history, approval rules,
// providers and keys, plans, the `/` lists) is on the protocol already.

/**
 * What keeps a channel's operation from working for every client on the
 * protocol: no method declares it (`declaration`); a method is declared but no
 * Studio serves it (`handler`); it is served to owners only where a paired
 * client should reach it (`grant`); the window's protocol client does not call
 * it (`client`); or the socket withholds the capability that offers it
 * (`withheld`).
 */
export type ConversationIpcGap = 'declaration' | 'handler' | 'grant' | 'client' | 'withheld'

export type ConversationIpcProtocol = {
  /** The methods a client on the protocol does this with. */
  readonly methods?: readonly StudioMethod[]
  /** The topics it follows instead of a channel's pushes. */
  readonly topics?: readonly StudioTopic[]
  /** What still keeps it from working for every client as it does over IPC; empty once nothing does. */
  readonly gaps: readonly ConversationIpcGap[]
  /** The methods and topics named for it that the protocol does not declare yet. */
  readonly planned?: readonly string[]
}

const DONE = [] as const

export const CONVERSATION_IPC_PROTOCOL = {
  // A turn's checkpoint: the chat view and the checkpoint window.
  'conversation:turn:diff': { methods: ['conversation.turnDiff'], gaps: DONE },
  'conversation:turn:revert': { methods: ['conversation.revert'], gaps: DONE },
  'conversation:turn:rewind': { methods: ['conversation.rewind'], gaps: DONE },
  'conversation:handoff': { methods: ['conversation.handoff'], gaps: DONE },
  'conversation:turn:fork': { methods: ['conversation.fork'], gaps: DONE },
  // Following one chat.
  'conversation:session:subscribe': { topics: ['conversation.session'], gaps: DONE },
  'conversation:session:unsubscribe': { topics: ['conversation.session'], gaps: DONE },
  'conversation:session:earlier': { methods: ['conversation.loadEarlier'], gaps: DONE },
  // A chat's live session, by its id: the chat view.
  'conversation:sessions:start': { methods: ['session.start'], gaps: DONE },
  'conversation:sessions:send-turn': { methods: ['session.send'], gaps: DONE },
  'conversation:sessions:interrupt': { methods: ['session.interrupt'], gaps: DONE },
  'conversation:sessions:respond-to-request': { methods: ['session.respond'], gaps: DONE },
  'conversation:sessions:set-permission': { methods: ['session.setPermission'], gaps: DONE },
  'conversation:sessions:set-model': { methods: ['session.setModel'], gaps: DONE },
  // By the session for the window, by the chat's key for a follower.
  'conversation:sessions:stop-subagent': {
    methods: ['session.stopSubagent', 'conversation.stopSubagent'],
    gaps: DONE,
  },
  'conversation:sessions:message-subagent': {
    methods: ['session.messageSubagent', 'conversation.messageSubagent'],
    gaps: DONE,
  },
  'conversation:sessions:side-question': {
    methods: ['session.askSideQuestion', 'conversation.askSideQuestion'],
    gaps: DONE,
  },
  'conversation:sessions:cancel-side-question': {
    methods: ['session.cancelSideQuestion', 'conversation.cancelSideQuestion'],
    gaps: DONE,
  },
  'conversation:sessions:context-breakdown': {
    methods: ['session.contextBreakdown', 'conversation.contextBreakdown'],
    gaps: DONE,
  },
  // Reads beside a chat.
  'conversation:tool-detail': { methods: ['conversation.toolDetail'], gaps: DONE },
  'conversation:event:read': { methods: ['conversation.event'], gaps: DONE },
  'conversation:attachment': { methods: ['conversation.attachment'], gaps: DONE },
} as const satisfies Partial<Record<ServerIpcChannelName, ConversationIpcProtocol>>
