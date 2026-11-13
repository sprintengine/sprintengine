// `@sprintengine/client-runtime`: what every Studio client runs, whatever it is
// drawn with. The desktop window, a web page, a script through
// `@sprintengine/agent-sdk` and the phone share it:
//
// - `rpc/`: the client of the Studio protocol over any transport that carries
//   whole frames, with its requests, streams, push topics and client tools;
// - `connection/`: the supervisor that keeps a connection up, the one set of
//   retry, wake and sign-in rules;
// - `capabilities/`: what a chat may show, read from what its server said.
//
// Nothing here imports Node or touches a DOM: the build compiles it against
// the globals in `portable/globals.d.ts` alone, which React Native, a browser
// and Node all provide. The fold of a conversation's events into rows is
// `@sprintengine/conversation-timeline`, held to the same rule.
export {
  negotiateChatCapabilities,
  studioOffers,
  type ChatCapabilities,
  type ChatServerOffer,
} from './capabilities/chatCapabilities.js'
export { StudioError, TERMINAL_CODES, isTerminalStudioCode } from './rpc/errors.js'
export type { StudioTransport, StudioTransportFactory } from './rpc/transport.js'
export {
  webSocketTransport,
  type StudioWebSocketConstructor,
  type StudioWebSocketLike,
  type StudioWebSocketTicket,
  type WebSocketTransportOptions,
} from './rpc/websocket.js'
export {
  connect,
  type ConnectOptions,
  type StudioClient,
  type StudioClientState,
  type StudioPushListener,
  type StudioConversationService,
} from './rpc/client.js'
// Reaching a Studio this client cannot talk to, for its updates (`update-session`).
export { openStudioUpdateSession, type StudioUpdateSession, type StudioUpdateSessionOptions } from './rpc/update.js'
export {
  agentConversations,
  approvalRequestOf,
  conversationHandle,
  createFrameQueue,
  type AgentConversations,
  type ApprovalRequest,
  type CommandOptions,
  type Conversation,
  type ConversationEventStream,
  type ConversationFollowFrame,
  type ConversationFollowOptions,
  type ConversationListing,
  type ConversationRef,
  type ConversationResult,
  type ConversationService,
  type CreateConversationInput,
  type EventStreamOptions,
} from './rpc/conversations.js'
export {
  StudioToolError,
  toolResult,
  type McpToolResult,
  type OfferedToolset,
  type StudioClientTools,
  type ToolAnswer,
  type ToolCall,
  type ToolDefinition,
  type ToolHandler,
  type ToolsetInput,
} from './rpc/tools.js'
export {
  ConnectTimeoutError,
  ConnectionStoppedError,
  ConnectionSupervisor,
  connectionRetryDelayMs,
  type ConnectionAttempt,
  type ConnectionBackoff,
  type ConnectionFailureVerdict,
  type ConnectionPhase,
  type ConnectionState,
  type ConnectionSupervisorOptions,
  type SupervisorClock,
} from './connection/connectionSupervisor.js'
