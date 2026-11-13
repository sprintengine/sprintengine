import {
  CONVERSATION_AGENT_MESSAGE_CAPABILITY,
  CONVERSATION_CHANGES_CAPABILITY,
  CONVERSATION_MESSAGE_FILES_CAPABILITY,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMANENT_APPROVALS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY,
  CONVERSATION_QUEUED_SENDS_CAPABILITY,
  CONVERSATION_QUOTE_TOKENS_CAPABILITY,
  CONVERSATION_RESTART_SESSION_CAPABILITY,
  CONVERSATION_SCHEDULED_SENDS_CAPABILITY,
  CONVERSATION_SEND_MENTIONS_CAPABILITY,
  CONVERSATION_SEND_SKILLS_CAPABILITY,
  CONVERSATION_SIDE_QUESTION_RECORDS_CAPABILITY,
  CONVERSATION_STEER_SENDS_CAPABILITY,
  CONVERSATION_USAGE_LIMITS_CAPABILITY,
  STUDIO_METHODS,
  studioGrantAllows,
  type StudioMethod,
  type StudioWelcomeFrame,
} from '../protocol.js'

// What a chat may show, read from the server it runs on. Every client asks this
// one function, whichever machine the chat is on: a window of the Studio that
// holds it, a paired machine's window, an embedded view, later the phone. A
// control is offered where the server serves what it calls *and* the grant
// reaches that method, by the protocol's own method table
// (`studioGrantAllows`), never by `grant.owner` and never by where the chat
// runs. Nothing here is a constant set: a chat on this machine and one on a
// paired machine with the same grant and the same server see the same.

/** What a chat view may offer, each as its server serves it and its grant reaches it. */
export type ChatCapabilities = {
  /** Send, stop, answer approvals and questions, change the preset. */
  operate: boolean
  /** An answered side question is kept in the chat's transcript, where a marker opens it again. */
  keepsSideQuestions: boolean
  /** Start the chat's provider session before its first send; elsewhere a send resumes one. */
  startSession: boolean
  /** Offer "always allow" rules, which outlive the conversation. */
  permanentApprovals: boolean
  /** Make a quote as a token, which the server expands for the agent; otherwise a blockquote. */
  quotes: boolean
  /** Revert a turn's files from its checkpoint, in the chat's checkout. */
  checkpointRevert: boolean
  /** Pick another model of the chat's CLI. */
  modelSwitch: boolean
  /** Mention files and folders of the chat's folder (@), searched where the chat runs. */
  mentions: boolean
  /** Attach files of any type, which go up to the server with the message. */
  attachFiles: boolean
  /** The `/` menu lists what the chat's CLI runs in the chat's folder. */
  commandList: boolean
  /** The chat takes all four permission presets, Manual and Auto among them. */
  permissionModes: boolean
  /** Hand a message to a turn that is running (a steer), where the provider takes one. */
  steer: boolean
  /** The server holds a message queued mid-turn and sends it when the turn ends. */
  hostQueue: boolean
  /** …with its images, files, skills and mentions, not its words alone. */
  hostQueueAttachments: boolean
  /** Attach skills to a message. */
  skills: boolean
  /** The server opens a pull request for the chat (Create PR). */
  hostPullRequests: boolean
  /** The server keeps and sends messages scheduled into the chat for a time. */
  hostSchedule: boolean
  /** The server says what it knows of its agents' usage limits, and sends the resume after one. */
  hostUsageLimits: boolean
  /** The server reads the chat's changes for a client's Diff tab. */
  hostChanges: boolean
  /** The person's words can be passed to one agent of the chat. */
  agentMessages: boolean
  /** End the chat's agent session, keeping the conversation, so the next message starts it again. */
  restartSession: boolean
  /** Sign the chat's CLI in, in a terminal of the chat's server. */
  providerSignIn: boolean
  /** Hand the chat to its CLI in a terminal of the chat's server (Resume in terminal). */
  resumeInTerminal: boolean
  /** The chat's server pages its transcript out for an export; elsewhere the view exports what it holds. */
  transcriptExport: boolean
}

/**
 * What a chat's server said of itself: a Studio's welcome, as every client on
 * the Studio protocol has one. Its own capabilities and the conversation
 * contract's, and the grant this client holds there.
 */
export type ChatServerOffer = {
  via: 'studio'
  welcome: Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant'>
}

/** Whether a Studio serves a method (its capability, where it names one) and the grant reaches it. */
export function studioOffers(
  welcome: Pick<StudioWelcomeFrame, 'capabilities' | 'grant'>,
  method: StudioMethod,
): boolean {
  const capability = STUDIO_METHODS[method].capability
  return (capability === null || welcome.capabilities.includes(capability)) && studioGrantAllows(welcome.grant, method)
}

/** A server that has said nothing yet: it serves nothing, and nothing is reached on it. */
const SAID_NOTHING: Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant'> = {
  capabilities: [],
  conversation: { protocolVersion: 0, minProtocolVersion: 0, capabilities: [] },
  grant: { clientId: '', name: '', owner: false, scopes: [], ceiling: 'none' },
}

/** A chat's capabilities from what its server said; nothing before it has said anything. */
export function negotiateChatCapabilities(offer: ChatServerOffer | null): ChatCapabilities {
  const welcome = offer?.welcome ?? SAID_NOTHING
  const serves = (name: string) => welcome.conversation.capabilities.includes(name)
  const offers = (method: StudioMethod) => studioOffers(welcome, method)
  const sends = offers('session.send')
  const queues = sends && serves(CONVERSATION_QUEUED_SENDS_CAPABILITY)
  return {
    operate: sends,
    keepsSideQuestions: serves(CONVERSATION_SIDE_QUESTION_RECORDS_CAPABILITY),
    startSession: offers('session.start'),
    permanentApprovals: offers('session.respond') && serves(CONVERSATION_PERMANENT_APPROVALS_CAPABILITY),
    quotes: sends && serves(CONVERSATION_QUOTE_TOKENS_CAPABILITY),
    checkpointRevert: offers('conversation.revert'),
    modelSwitch: offers('session.setModel') && serves(CONVERSATION_MODELS_CAPABILITY),
    // An @ is a search of the chat's folder and a name the send carries: a
    // search of the folder by path where the grant reads files there
    // (`files.search`), else of the chat's own folder by its key
    // (`conversation.searchFiles`, a paired device's).
    mentions:
      sends &&
      (offers('files.search') || offers('conversation.searchFiles')) &&
      serves(CONVERSATION_SEND_MENTIONS_CAPABILITY),
    attachFiles: sends && serves(CONVERSATION_MESSAGE_FILES_CAPABILITY),
    // By the chat's folder (`conversation.commands`), or by its key (`conversation.listCommands`).
    commandList: offers('conversation.commands') || offers('conversation.listCommands'),
    permissionModes: serves(CONVERSATION_PERMISSION_MODES_CAPABILITY),
    steer: sends && serves(CONVERSATION_STEER_SENDS_CAPABILITY),
    hostQueue: queues,
    hostQueueAttachments: queues && serves(CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY),
    skills: sends && serves(CONVERSATION_SEND_SKILLS_CAPABILITY),
    // Create PR, every step in the chat's checkout on its Studio.
    hostPullRequests: sends && offers('pullRequests.create'),
    hostSchedule: serves(CONVERSATION_SCHEDULED_SENDS_CAPABILITY),
    hostUsageLimits: serves(CONVERSATION_USAGE_LIMITS_CAPABILITY),
    hostChanges: serves(CONVERSATION_CHANGES_CAPABILITY),
    agentMessages: offers('session.messageSubagent') && serves(CONVERSATION_AGENT_MESSAGE_CAPABILITY),
    restartSession: offers('conversation.restartSession') && serves(CONVERSATION_RESTART_SESSION_CAPABILITY),
    // Both open a terminal on the Studio's machine: an owner's methods there.
    providerSignIn: offers('providers.signIn') && offers('terminal.open'),
    resumeInTerminal: offers('session.terminalHandoff') && offers('terminal.open'),
    transcriptExport: offers('conversation.exportPage'),
  }
}
