import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  CONVERSATION_SESSION_NOT_FOUND,
  conversationUtf8Length,
  type ConversationCommand,
  type ConversationWireEvent as ConversationEvent,
} from "../../../../packages/conversation-protocol/src/public";
import { STUDIO_MAX_CLIENT_FRAME_BYTES } from "../../../../packages/studio-protocol/src/public";

// The phone's own rules for what it sends a chat and how it reads the answer:
// what a message may hold, how the person's line breaks go, and how a send
// held by the desktop is known once it has gone into the chat. The shapes are
// the contract's (`@sprintengine/conversation-protocol`); the rules are the
// phone's.

/** A key as long as any a request names, for measuring one before it is made. */
const OVERSIZED_KEY = { workspaceId: "w".repeat(200), agentId: "a".repeat(200) };

/**
 * Whether a `user_message` is a message the phone handed the desktop to hold
 * and has not heard back about: one that came into the chat after the phone
 * first offered it (`afterSeq`, the phone's cursor then) and carries its
 * words as whole lines. The desktop joins messages queued in one turn, a line
 * apiece, and sends the join under an id of its own, so the words are all
 * there is to know it by. Read only for a held send still unanswered: one
 * the phone carried across a closed app (its answer never heard) would
 * otherwise be offered again after the desktop had already sent it, and the
 * desktop, no longer holding it, would hold it a second time. Across a
 * dropped connection no answer is lost: the client sends the request again
 * under its id and the desktop answers it once.
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
 * `session_not_found`. Where it is not passed on as that code, it arrives as
 * `unavailable` carrying the runtime's own sentence, which says this and
 * nothing else; the desktop's chat view reads it the same way.
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
  // As the request that carries it: the method, its id and its params.
  const { kind, ...members } = command;
  const request = { t: "req", id: commandId, method: `conversation.${kind}`, params: { key: OVERSIZED_KEY, commandId, ...members } };
  if (conversationUtf8Length(JSON.stringify(request)) > STUDIO_MAX_CLIENT_FRAME_BYTES)
    return "This message is too large to send to the desktop.";
  return null;
}
