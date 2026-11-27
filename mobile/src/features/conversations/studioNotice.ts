// A message Studio sent a chat itself, rather than the person: news from an
// agent the chat launched, a resume once a usage limit that stopped the chat
// has reset, or the `/compact` it sent an idle chat. The desktop records it
// as a `user_message` like any other, since the agent is handed it as a
// turn, and marks it with an `origin` on the payload. The shared projection
// reads that member (conversation-protocol's `readConversationMessageOrigin`)
// and lays the message out as Studio's row (`kind: 'studio'`), so the phone
// keeps only how the row says it: under Studio's name, without the name the
// words open with.

/** The name Studio's notice row is said under. */
export const STUDIO_NAME = "SprintEngine Studio";

/**
 * How a notice's text opens: the agent is handed it as plain text, which has
 * no field for who is speaking, so the desktop puts its name in the words
 * (`shared/studio-notice.ts` there). A row that already says it is Studio's
 * leaves it out.
 */
export const STUDIO_NOTICE_PREFIX = `[${STUDIO_NAME}]`;

/** The notice's words without the name they open with. */
export function withoutStudioNoticePrefix(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(STUDIO_NOTICE_PREFIX) ? trimmed.slice(STUDIO_NOTICE_PREFIX.length).trimStart() : text;
}
