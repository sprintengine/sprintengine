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
// channels `registerConversationIpc` and `registerConversationCommandsIpc`
// register, both ways, so a new conversation channel cannot be added without
// saying how a client on the protocol does the same. Moving the window onto
// the protocol deletes channels from it, and the IPC is gone when it is empty.

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
  // History, the palette's search and the history navigation. The IPC's
  // partial batches (`conversation:search:batch`) are not carried: the method
  // answers every hit of a workspace at once.
  'conversation:threads': { methods: ['conversation.threads'], gaps: ['client', 'grant'] },
  'conversation:search': { methods: ['conversation.search'], gaps: ['client', 'grant'] },
  'conversation:search:cancel': { methods: ['conversation.cancelSearch'], gaps: ['client', 'grant'] },
  // Settings ▸ Approvals.
  'conversation:approval-rules:list': { methods: ['conversation.approvalRules'], gaps: ['client', 'grant'] },
  'conversation:approval-rules:revoke': { methods: ['conversation.revokeApprovalRule'], gaps: ['client', 'grant'] },
  // A turn's checkpoint: the chat view and the checkpoint window.
  'conversation:turn:diff': { methods: ['conversation.turnDiff'], gaps: ['client'] },
  'conversation:turn:revert': { methods: ['conversation.revert'], gaps: ['grant'] },
  'conversation:turn:rewind': { methods: ['conversation.rewind'], gaps: ['grant'] },
  'conversation:handoff': { methods: ['conversation.handoff'], gaps: ['grant'] },
  'conversation:turn:fork': { methods: ['conversation.fork'], gaps: ['grant'] },
  // Following one chat.
  'conversation:session:subscribe': { topics: ['conversation.session'], gaps: DONE },
  'conversation:session:unsubscribe': { topics: ['conversation.session'], gaps: DONE },
  'conversation:session:earlier': { methods: ['conversation.loadEarlier'], gaps: DONE },
  // Providers and their keys: the model picker and Settings ▸ Providers.
  'conversation:providers:list': { methods: ['providers.list'], gaps: ['grant', 'client'] },
  'conversation:providers:models': { methods: ['providers.models'], gaps: ['grant'] },
  'conversation:providers:sign-in': { methods: ['providers.signIn'], gaps: ['client', 'grant'] },
  'conversation:secrets:status': { methods: ['providers.secretStatus'], gaps: ['grant', 'client'] },
  'conversation:secrets:set': { methods: ['providers.setSecret'], gaps: ['client', 'grant'] },
  'conversation:secrets:clear': { methods: ['providers.clearSecret'], gaps: ['client', 'grant'] },
  // A chat's live session, by its id: the chat view.
  'conversation:sessions:start': { methods: ['session.start'], gaps: ['grant'] },
  'conversation:sessions:send-turn': { methods: ['session.send'], gaps: ['grant'] },
  'conversation:sessions:interrupt': { methods: ['session.interrupt'], gaps: ['grant'] },
  'conversation:sessions:respond-to-request': { methods: ['session.respond'], gaps: ['grant'] },
  'conversation:sessions:set-permission': { methods: ['session.setPermission'], gaps: ['grant'] },
  'conversation:sessions:set-model': { methods: ['session.setModel'], gaps: ['grant'] },
  // By the session for the window, by the chat's key for a follower.
  'conversation:sessions:mcp-action': {
    methods: ['session.mcpServerAction', 'conversation.mcpServerAction'],
    gaps: ['client', 'grant'],
  },
  'conversation:sessions:stop-subagent': {
    methods: ['session.stopSubagent', 'conversation.stopSubagent'],
    gaps: ['client', 'grant'],
  },
  'conversation:sessions:message-subagent': {
    methods: ['session.messageSubagent', 'conversation.messageSubagent'],
    gaps: ['client', 'grant'],
  },
  // A follower's keyed form is the conversation lane's, which the socket withholds.
  'conversation:sessions:side-question': {
    methods: ['session.askSideQuestion'],
    gaps: ['declaration', 'client', 'grant', 'withheld'],
    planned: ['conversation.askSideQuestion'],
  },
  'conversation:sessions:cancel-side-question': {
    methods: ['session.cancelSideQuestion'],
    gaps: ['declaration', 'client', 'grant', 'withheld'],
    planned: ['conversation.cancelSideQuestion'],
  },
  'conversation:sessions:context-breakdown': {
    methods: ['session.contextBreakdown'],
    gaps: ['declaration', 'client', 'grant', 'withheld'],
    planned: ['conversation.contextBreakdown'],
  },
  'conversation:sessions:stop': { methods: ['session.stop', 'conversation.stop'], gaps: ['client', 'grant'] },
  'conversation:sessions:suspend': { methods: ['session.suspend'], gaps: ['client', 'grant'] },
  // Answers the terminal agent it started; the terminal itself is the terminal service's.
  'conversation:sessions:terminal-handoff': { methods: ['session.terminalHandoff'], gaps: ['client', 'grant'] },
  'conversation:sessions:list': { methods: ['session.list'], gaps: ['client', 'grant'] },
  // Reads beside a chat.
  'conversation:tool-detail': { methods: ['conversation.toolDetail'], gaps: ['client'] },
  'conversation:event:read': { methods: ['conversation.event'], gaps: DONE },
  'conversation:attachment': { methods: ['conversation.attachment'], gaps: ['grant'] },
  'conversation:plan-document': { methods: ['conversation.planDocument'], gaps: ['grant'] },
  // Every chat's lifecycle, for the sessions list.
  'conversation:events:subscribe': { topics: ['conversation.events'], gaps: ['client', 'grant'] },
  'conversation:events:unsubscribe': { topics: ['conversation.events'], gaps: ['client', 'grant'] },
  // The composer's `/` menu.
  'conversation-commands:list': {
    methods: ['conversation.commands'],
    topics: ['conversation.commands'],
    gaps: ['grant'],
  },
} as const satisfies Partial<Record<ServerIpcChannelName, ConversationIpcProtocol>>
