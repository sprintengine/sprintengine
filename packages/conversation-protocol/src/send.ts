import type { ConversationSendMode } from './commands.js'
import type { ConversationAttachedFile, ConversationMentionRef } from './messageParts.js'

// One message a person sends a chat, and the answer they give a tool's
// permission request: each defined here once. Every way of sending one
// derives from these and adds only its addressing — the window's own send and
// the runtime's input (a session id), the Studio protocol's `session.send` (a
// session id and a command id), a paired desktop's mesh IPC (the chat's key),
// and the conversation lane between two machines (`ConversationCommand`'s
// `send`). A part added to the request fails typecheck until the lane says
// how it carries it (`LANE_CARRIAGE`).

/** A skill a send runs with: its id, and the file it was read from when it is not the CLI's own. */
export type ConversationSkillRef = { id: string; sourcePath?: string }

/** The mode a turn runs in. `default` is the same as naming none. */
export type ConversationTurnMode = 'default' | ConversationSendMode

/**
 * A picture a send carries by the upload that holds its bytes on the machine
 * that runs the chat: the client's own id for it, the upload's, and its name.
 */
export type ConversationSendUpload = { id: string; uploadId: string; name?: string }

/**
 * One message a person sends a chat, whichever way it travels.
 *
 * `Picture` is the one part whose form is the transport's own: its bytes
 * inside one machine (`ConversationImageAttachment`), or the upload holding
 * them on the machine that runs the chat (`ConversationSendUpload`, the
 * default).
 */
export type ConversationSendRequest<Picture = ConversationSendUpload> = {
  /** The person's words. */
  message: string
  /** The client's id for its optimistic bubble, echoed on the `user_message` the send becomes. */
  localTurnId?: string
  /** Files and folders of the chat's folder, as the composer's @ chips name them. */
  mentions?: ConversationMentionRef[]
  /** Files attached by path on the machine that runs the chat. */
  files?: ConversationAttachedFile[]
  /** Skills the chat runs with this message. */
  skills?: ConversationSkillRef[]
  /** Pictures, honoured by a provider that sees them; refused in words by one that does not. */
  attachments?: Picture[]
  /** The reasoning effort this turn runs at, where the chat's provider offers one. */
  reasoningEffort?: string
  mode?: ConversationTurnMode
  /** Into the turn that is running, where the provider takes one; with none running, an ordinary send. */
  steer?: boolean
  /** Held by the machine that runs the chat until its turn ends, and sent then. */
  queue?: boolean
  /**
   * When the person wrote it, on the sending device's clock (epoch ms). One
   * written longer ago than `CONVERSATION_STALE_SEND_MS` is refused `stale`
   * unless `confirmedStale` says the person asked for it to go now.
   */
  composedAt?: number
  confirmedStale?: boolean
}

/**
 * How the conversation lane carries each part of a request between two
 * machines, the receiving one being a desktop that may be older or newer
 * than the sender (version skew is handled by the lane's capabilities):
 *
 * - `as-is`: the same member, the same type.
 * - `uploaded`: sent up the upload route first, and named by its upload's id
 *   in `uploadIds`; the desktop tells pictures and files apart by what it kept.
 * - `by-id`: by its id only; the desktop resolves it against its own folder.
 * - `when-set`: `true` or left out.
 * - `unless-default`: left out when it is the default.
 * - `not-carried`: the lane has its own way to say it — a device's bubble is
 *   its command id, and a chat's effort is the lane's `setReasoningEffort`.
 */
const LANE_CARRIAGE = {
  message: 'as-is',
  mentions: 'as-is',
  composedAt: 'as-is',
  attachments: 'uploaded',
  files: 'uploaded',
  skills: 'by-id',
  steer: 'when-set',
  queue: 'when-set',
  confirmedStale: 'when-set',
  mode: 'unless-default',
  localTurnId: 'not-carried',
  reasoningEffort: 'not-carried',
} as const satisfies Record<
  keyof ConversationSendRequest,
  'as-is' | 'uploaded' | 'by-id' | 'when-set' | 'unless-default' | 'not-carried'
>

type Carried<How> = {
  [K in keyof typeof LANE_CARRIAGE]: (typeof LANE_CARRIAGE)[K] extends How ? K : never
}[keyof typeof LANE_CARRIAGE]

/** The parts of a request the lane says its own way, which a sender to a paired machine does not set. */
export type ConversationLaneNotCarried = Carried<'not-carried'>

/**
 * A request as the conversation lane carries it (`ConversationCommand`'s
 * `send`), each part as `LANE_CARRIAGE` says.
 */
export type ConversationLaneSend = Pick<ConversationSendRequest, Carried<'as-is'>> & {
  /** The request's pictures and files, by the uploads that hold them on the desktop. */
  uploadIds?: string[]
} & { [K in Carried<'by-id'>]?: ConversationSkillRef['id'][] } & { [K in Carried<'when-set'>]?: true } & {
  [K in Carried<'unless-default'>]?: Exclude<ConversationTurnMode, 'default'>
}
