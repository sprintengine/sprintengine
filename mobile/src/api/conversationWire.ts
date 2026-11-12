import {
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_SESSION_NOT_FOUND,
  conversationUtf8Length,
  createConversationChunkAssembler,
  createConversationSnapshotAssembler,
  decodeConversationServerFrame,
  parseConversationWireEvent,
  type ConversationClientMessage,
  type ConversationCommand as ConversationContractCommand,
  type ConversationDecodedFrame,
  type ConversationListedThread,
  type ConversationQueuedMessage as ConversationContractQueuedMessage,
  type ConversationScheduledMessage as ConversationContractScheduledMessage,
  type ConversationSubagent as ConversationContractSubagent,
  type ConversationSubagentStatus as ConversationContractSubagentStatus,
  type ConversationUsageLimitSnapshot as ConversationContractUsageLimitSnapshot,
  type ConversationUsageLimitWindow as ConversationContractUsageLimitWindow,
  type ConversationWireEvent,
  type ConversationWireHost,
  type ConversationWireKey,
  type ConversationWireLocalServer,
  type ConversationWirePermissionPreset,
  type ConversationWirePullRequest,
  type ConversationWirePullRequestState,
} from "../../../packages/conversation-protocol/src/public";

// The phone's side of the tailnet conversation lane. Every frame, event and
// command is the desktop's contract (`@sprintengine/conversation-protocol`),
// read by its own decoder: a member this build does not know is dropped, a
// frame of a type it does not know decodes to `{ type: "unknown" }` and is
// passed over, an event of a type it does not know still moves the cursor,
// and a chat in a phase it does not know is listed as `unknown`. What is left
// here is the phone's own: the socket's address, and its rules for what it
// sends and what it shows.
export const CONVERSATION_SOCKET_PATH = "/tailnet/v1/conversation";
export {
  CONVERSATION_DEFAULT_MODEL_ID,
  CONVERSATION_MODELS_CAPABILITY,
  CONVERSATION_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_QUOTE_TOKENS_CAPABILITY,
  CONVERSATION_WIRE_PERMISSION_PRESETS,
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_IMAGES,
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_MAX_PULL_REQUESTS,
  CONVERSATION_RESYNC_CLOSE_CODE,
  CONVERSATION_SCOPE_CLOSE_CODE,
  CONVERSATION_SESSION_NOT_FOUND,
  conversationCloseRetryAfterMs,
  presentToolItem,
} from "../../../packages/conversation-protocol/src/public";

/** The id the desktop gives its own machine: a chat there wears no machine mark. */
export const CONVERSATION_LOCAL_HOST_ID = "local";

/**
 * `bypass` skips the CLI's prompts, `auto` lets edits in the workspace through
 * and asks before anything riskier, `manual` asks before every edit, command
 * and outside call, and `none` passes no permission flag. A desktop that does
 * not declare `conversation-permission-modes` runs only `none` and `bypass`.
 */
export type ConversationPermissionPreset = ConversationWirePermissionPreset;
export type ConversationKey = ConversationWireKey;
/** A listed chat, as the desktop's contract reads it. */
export type ConversationThread = ConversationListedThread;
export type ConversationPhase = ConversationListedThread["phase"];
export type ConversationEvent = ConversationWireEvent;
export type ConversationSubagent = ConversationContractSubagent;
export type ConversationSubagentStatus = ConversationContractSubagentStatus;
/** A message the desktop holds for a chat until its turn ends, with what it carries beside its words. */
export type ConversationQueuedMessage = ConversationContractQueuedMessage;
export type ConversationScheduledMessage = ConversationContractScheduledMessage;
export type ConversationUsageLimitSnapshot = ConversationContractUsageLimitSnapshot;
export type ConversationUsageLimitWindow = ConversationContractUsageLimitWindow;
export type ConversationHost = ConversationWireHost;
export type ConversationPullRequest = ConversationWirePullRequest;
export type ConversationPullRequestState = ConversationWirePullRequestState;
export type ConversationLocalServer = ConversationWireLocalServer;
export type ConversationCommand = ConversationContractCommand;
export type ConversationClientFrame = ConversationClientMessage;
export type ConversationServerFrame = ConversationDecodedFrame;

/** Whether a value is an event the wire takes; a page read outside a frame is held to the same. */
export function isConversationEvent(value: unknown): value is ConversationEvent {
  return parseConversationWireEvent(value) !== null;
}

/** One frame's JSON text, decoded by the desktop's contract; null for a broken one. */
export function parseConversationFrame(raw: string): ConversationServerFrame | null {
  return decodeConversationServerFrame(raw);
}

/** A reassembled frame is emitted only once all numbered chunks arrived. */
export { createConversationChunkAssembler };
/** A snapshot sent in parts is applied only whole. */
export const createSnapshotAssembler = createConversationSnapshotAssembler;

const wireBytes = conversationUtf8Length;

/** The longest pull request address the desktop lists; it drops a longer one too. */
const MAX_PULL_REQUEST_URL_LENGTH = 2_000;

/**
 * A pull request's address as the phone will hand it to the browser, or null.
 * Only a web page: `http(s)://`, a host, and no credentials before it, so
 * `https://github.com@elsewhere.example/` cannot pass for GitHub. The phone
 * opens the address the desktop gave and never builds one of its own.
 */
export function pullRequestUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (address.length > MAX_PULL_REQUEST_URL_LENGTH) return null;
  return /^https?:\/\/[^\s/?#@\\]+(?:[/?#][^\s]*)?$/iu.test(address) ? address : null;
}

export function conversationSocketUrl(baseUrl: string, ticket: string): string {
  const url = new URL(
    CONVERSATION_SOCKET_PATH,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/**
 * Whether a `user_message` is a message the phone handed the desktop to hold
 * and has not heard back about: one that came into the chat after the phone
 * first offered it (`afterSeq`, the phone's cursor then) and carries its
 * words as whole lines. The desktop joins messages queued in one turn, a line
 * apiece, and sends the join under an id of its own, so the words are all
 * there is to know it by. Read only for a held send still unanswered: an
 * answer lost with a dropped socket would otherwise have the phone offer it
 * again after the desktop had already sent it, and the desktop, no longer
 * holding it, would hold it a second time.
 *
 * The trade-off: words are not an identity. If the offer never reached the
 * desktop at all, and a message with the same words reaches the chat after
 * it from elsewhere (a "yes" typed on the desktop), the phone takes that for
 * delivery and the phone's "yes" is never sent. The stream narrows this to
 * the first person's message after the offer (the desktop sends what it
 * holds before anything sent later, and refuses or joins a send made while
 * the turn runs), so only that one message can be mistaken for it. Losing a
 * repeat of words the chat has just been sent is the lesser harm: the other
 * error is the agent being told the same thing twice, a second turn spent on
 * it, with no way for the person to take it back.
 */
export function heldSendLanded(
  event: Pick<ConversationEvent, "type" | "seq" | "payload">,
  message: string,
  afterSeq: number,
): boolean {
  if (event.type !== "user_message" || event.seq === undefined || event.seq <= afterSeq) return false;
  const text = event.payload?.text;
  const words = message.trim();
  if (typeof text !== "string" || !words) return false;
  return `\n${text}\n`.includes(`\n${words}\n`);
}


/**
 * The refusal of a command about a session the desktop's runtime no longer
 * holds: the Studio server running the chat restarted (a WSL distribution's,
 * an SSH machine's, the desktop's own out of process) between the desktop
 * finding the session and using it. The runtime names it
 * `session_not_found`. The tailnet lane passes no runtime code on, so there it
 * arrives as `unavailable` carrying the runtime's own sentence, which says
 * this and nothing else; the desktop's chat view reads it the same way.
 */
const LOST_SESSION_WORDS = "Conversation session is invalid.";
export function conversationSessionWasLost(result: { ok: boolean; code?: string; message?: string }): boolean {
  if (result.ok) return false;
  if (result.code === CONVERSATION_SESSION_NOT_FOUND) return true;
  return (result.code === undefined || result.code === "unavailable") && result.message === LOST_SESSION_WORDS;
}
/** What an answer to a request on a lost session is told: nothing waits for it now. */
export const LOST_REQUEST_SENTENCE =
  "This request ended with the session it belonged to (the server running the chat restarted). Send a message to carry on.";

/**
 * Line and paragraph separators as one plain line break. The phone's
 * recogniser, the keyboard's dictation or a paste can hand the composer
 * U+2028, U+2029, U+0085 or a carriage return; a message goes to the desktop
 * with plain line breaks, whatever typed or pasted it.
 */
export function plainLineBreaks(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029\u0085]/gu, "\n");
}

/**
 * Why a send cannot go to the desktop as written, or null when it can. The
 * limits are the protocol's own, so a message this accepts is never refused
 * for size and one it refuses never reaches the durable outbox, where it
 * would be retried on every reconnect.
 */
export function conversationSendProblem(
  commandId: string,
  command: Extract<ConversationCommand, { kind: "send" }>,
): string | null {
  // The desktop refuses the frame whole, so it is never offered at all.
  if (command.steer === true && (command.queue === true || command.uploadIds !== undefined))
    return "A message steered into the turn carries its words alone.";
  if (command.message.length > CONVERSATION_MAX_MESSAGE_CHARS)
    return `This message is ${command.message.length.toLocaleString("en-US")} characters; the desktop accepts at most ${CONVERSATION_MAX_MESSAGE_CHARS.toLocaleString("en-US")}.`;
  const frame: ConversationClientFrame = { type: "command", commandId, command };
  if (wireBytes(JSON.stringify(frame)) > CONVERSATION_MAX_CLIENT_FRAME_BYTES)
    return "This message is too large to send to the desktop.";
  return null;
}
