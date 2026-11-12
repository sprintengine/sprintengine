import type { StudioMethod, StudioTopic } from '../../packages/studio-protocol/src/public'

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

export const CONVERSATION_IPC_PROTOCOL: Readonly<Record<string, ConversationIpcProtocol>> = {
  // History, the palette's search and the history navigation.
  'conversation:threads': { gaps: ['declaration'], planned: ['conversation.threads'] },
  'conversation:search': {
    gaps: ['declaration'],
    planned: ['conversation.search', 'conversation.searchBatches'],
  },
  'conversation:search:cancel': { gaps: ['declaration'], planned: ['conversation.cancelSearch'] },
  // Settings ▸ Approvals.
  'conversation:approval-rules:list': { gaps: ['declaration'], planned: ['conversation.approvalRules'] },
  'conversation:approval-rules:revoke': { gaps: ['declaration'], planned: ['conversation.revokeApprovalRule'] },
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
  'conversation:providers:sign-in': { gaps: ['declaration'], planned: ['providers.signIn'] },
  'conversation:secrets:status': { methods: ['providers.secretStatus'], gaps: ['grant', 'client'] },
  'conversation:secrets:set': { gaps: ['declaration'], planned: ['providers.setSecret'] },
  'conversation:secrets:clear': { gaps: ['declaration'], planned: ['providers.clearSecret'] },
  // A chat's live session, by its id: the chat view.
  'conversation:sessions:start': { methods: ['session.start'], gaps: ['grant'] },
  'conversation:sessions:send-turn': { methods: ['session.send'], gaps: ['grant'] },
  'conversation:sessions:interrupt': { methods: ['session.interrupt'], gaps: ['grant'] },
  'conversation:sessions:respond-to-request': { methods: ['session.respond'], gaps: ['grant'] },
  'conversation:sessions:set-permission': { methods: ['session.setPermission'], gaps: ['grant'] },
  'conversation:sessions:set-model': { methods: ['session.setModel'], gaps: ['grant'] },
  // Declared by key for a follower (`conversation.mcpServerAction`, …), with
  // no session form the window's client could call.
  'conversation:sessions:mcp-action': {
    methods: ['conversation.mcpServerAction'],
    gaps: ['declaration', 'client', 'grant'],
    planned: ['session.mcpServerAction'],
  },
  'conversation:sessions:stop-subagent': {
    methods: ['conversation.stopSubagent'],
    gaps: ['declaration', 'client', 'grant'],
    planned: ['session.stopSubagent'],
  },
  'conversation:sessions:message-subagent': {
    methods: ['conversation.messageSubagent'],
    gaps: ['declaration', 'client', 'grant'],
    planned: ['session.messageSubagent'],
  },
  'conversation:sessions:side-question': {
    gaps: ['declaration', 'withheld'],
    planned: ['session.askSideQuestion', 'conversation.askSideQuestion'],
  },
  'conversation:sessions:cancel-side-question': {
    gaps: ['declaration', 'withheld'],
    planned: ['session.cancelSideQuestion', 'conversation.cancelSideQuestion'],
  },
  'conversation:sessions:context-breakdown': {
    gaps: ['declaration', 'withheld'],
    planned: ['session.contextBreakdown', 'conversation.contextBreakdown'],
  },
  'conversation:sessions:stop': { methods: ['conversation.stop'], gaps: ['declaration'], planned: ['session.stop'] },
  'conversation:sessions:suspend': { gaps: ['declaration'], planned: ['session.suspend'] },
  // Answers the command line; the terminal it opens is the terminal service's.
  'conversation:sessions:terminal-handoff': { gaps: ['declaration'], planned: ['session.terminalHandoff'] },
  'conversation:sessions:list': { gaps: ['declaration'], planned: ['session.list'] },
  // Reads beside a chat.
  'conversation:tool-detail': { methods: ['conversation.toolDetail'], gaps: ['client'] },
  'conversation:attachment': { methods: ['conversation.attachment'], gaps: ['grant'] },
  'conversation:plan-document': { methods: ['conversation.planDocument'], gaps: ['grant'] },
  // Every chat's lifecycle, for the sessions list.
  'conversation:events:subscribe': { gaps: ['declaration'], planned: ['conversation.events'] },
  'conversation:events:unsubscribe': { gaps: ['declaration'], planned: ['conversation.events'] },
  // The composer's `/` menu.
  'conversation-commands:list': {
    methods: ['conversation.commands'],
    topics: ['conversation.commands'],
    gaps: ['grant'],
  },
}

/** The channels whose operation still does not work for every client on the protocol, with why. */
export function conversationIpcGaps(): Array<{ channel: string; gaps: readonly ConversationIpcGap[] }> {
  return Object.entries(CONVERSATION_IPC_PROTOCOL)
    .filter(([, route]) => route.gaps.length > 0)
    .map(([channel, route]) => ({ channel, gaps: route.gaps }))
}
