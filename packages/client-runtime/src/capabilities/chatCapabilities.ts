import {
  CONVERSATION_AGENT_MESSAGE_CAPABILITY,
  CONVERSATION_CHANGES_CAPABILITY,
  CONVERSATION_CHECKPOINT_REVERT_CAPABILITY,
  CONVERSATION_COMMANDS_CAPABILITY,
  CONVERSATION_FILE_SEARCH_CAPABILITY,
  CONVERSATION_MESSAGE_FILES_CAPABILITY,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMANENT_APPROVALS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY,
  CONVERSATION_QUEUED_SENDS_CAPABILITY,
  CONVERSATION_QUOTE_TOKENS_CAPABILITY,
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
  /** The server echoes an optimistic turn's id back on its `user_message`. */
  optimisticTurns: boolean
  /** The chat's permission preset is known before a session reports it. */
  reportsPreset: boolean
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
}

/**
 * What a chat's server said of itself.
 *
 * - `studio`: a Studio's welcome, as every client on the Studio protocol has
 *   one. Its own capabilities and the conversation contract's, and the grant
 *   this client holds there.
 * - `paired-lane`: a paired machine's chat followed over the tailnet lane, the
 *   capabilities it published and the access its pairing holds. Read only
 *   until the paired desktop is on the Studio protocol too, when it has a
 *   welcome of its own; nothing else may offer this.
 */
export type ChatServerOffer =
  | { via: 'studio'; welcome: Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant'> }
  | {
      via: 'paired-lane'
      capabilities: readonly string[]
      access: 'operate' | 'read' | null
      /** The lane lists the chat's model catalog; without one there is nothing to switch to. */
      modelCatalog: boolean
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
  if (offer?.via === 'paired-lane') return pairedLaneCapabilities(offer)
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
    // An @ is a search of the chat's folder (`files.search`) and a name the send carries.
    mentions: sends && offers('files.search') && serves(CONVERSATION_SEND_MENTIONS_CAPABILITY),
    attachFiles: sends && serves(CONVERSATION_MESSAGE_FILES_CAPABILITY),
    commandList: offers('conversation.commands'),
    // A send on the Studio protocol carries its bubble's id, which the
    // `user_message` echoes, and a chat's session reports its preset.
    optimisticTurns: sends,
    reportsPreset: sends,
    permissionModes: serves(CONVERSATION_PERMISSION_MODES_CAPABILITY),
    steer: sends && serves(CONVERSATION_STEER_SENDS_CAPABILITY),
    hostQueue: queues,
    hostQueueAttachments: queues && serves(CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY),
    skills: sends && serves(CONVERSATION_SEND_SKILLS_CAPABILITY),
    // No method of the Studio protocol opens a pull request yet.
    hostPullRequests: false,
    hostSchedule: serves(CONVERSATION_SCHEDULED_SENDS_CAPABILITY),
    hostUsageLimits: serves(CONVERSATION_USAGE_LIMITS_CAPABILITY),
    hostChanges: serves(CONVERSATION_CHANGES_CAPABILITY),
    agentMessages: offers('session.messageSubagent') && serves(CONVERSATION_AGENT_MESSAGE_CAPABILITY),
  }
}

/**
 * A paired machine's chat over the tailnet lane: what the pairing's access
 * lets it do, and what the machine publishes it does beyond the turn. The lane
 * carries no bubble id, names a preset only from a desktop that keeps one, and
 * starts no session from here (a send there resumes one).
 */
function pairedLaneCapabilities(offer: Extract<ChatServerOffer, { via: 'paired-lane' }>): ChatCapabilities {
  const has = (name: string) => offer.capabilities.includes(name)
  const operate = offer.access === 'operate'
  const queues = operate && has(CONVERSATION_QUEUED_SENDS_CAPABILITY)
  return {
    operate,
    keepsSideQuestions: has(CONVERSATION_SIDE_QUESTION_RECORDS_CAPABILITY),
    startSession: false,
    permanentApprovals: operate && has(CONVERSATION_PERMANENT_APPROVALS_CAPABILITY),
    quotes: operate && has(CONVERSATION_QUOTE_TOKENS_CAPABILITY),
    checkpointRevert: operate && has(CONVERSATION_CHECKPOINT_REVERT_CAPABILITY),
    modelSwitch: operate && has(CONVERSATION_MODELS_CAPABILITY) && offer.modelCatalog,
    // An @ is a search there and a name the send carries back, so both or neither.
    mentions: operate && has(CONVERSATION_FILE_SEARCH_CAPABILITY) && has(CONVERSATION_SEND_MENTIONS_CAPABILITY),
    // A file goes up through the machine's upload route.
    attachFiles: operate && has(CONVERSATION_MESSAGE_FILES_CAPABILITY) && has('upload'),
    commandList: operate && has(CONVERSATION_COMMANDS_CAPABILITY),
    optimisticTurns: false,
    reportsPreset: false,
    permissionModes: has(CONVERSATION_PERMISSION_MODES_CAPABILITY),
    steer: operate && has(CONVERSATION_STEER_SENDS_CAPABILITY),
    hostQueue: queues,
    hostQueueAttachments: queues && has(CONVERSATION_QUEUED_ATTACHMENTS_CAPABILITY),
    // Its skills are listed by the machine's extensions.
    skills: operate && has(CONVERSATION_SEND_SKILLS_CAPABILITY) && has('workspace-extensions'),
    hostPullRequests: operate && has('chat-create-pull-request'),
    hostSchedule: has(CONVERSATION_SCHEDULED_SENDS_CAPABILITY),
    hostUsageLimits: has(CONVERSATION_USAGE_LIMITS_CAPABILITY),
    hostChanges: has(CONVERSATION_CHANGES_CAPABILITY),
    agentMessages: operate && has(CONVERSATION_AGENT_MESSAGE_CAPABILITY),
  }
}
