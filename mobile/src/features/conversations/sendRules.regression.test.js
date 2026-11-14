/* global Buffer */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_MESSAGE_CHARS,
} = require("../../../.mobile-test-build/packages/conversation-protocol/src/public.js");
const {
  conversationSendProblem,
  conversationSessionWasLost,
  heldSendLanded,
  plainLineBreaks,
} = require("../../../.mobile-test-build/mobile/src/features/conversations/sendRules.js");

// The phone's own rules for what it sends a chat. What a frame is and how one
// is read is the contract's (`@sprintengine/conversation-protocol`), tested there.

test("sends are measured against the protocol's own message and request limits", () => {
  const send = (message) => ({ kind: "send", message, uploadIds: [] });
  assert.equal(conversationSendProblem("c", send("hello")), null);
  assert.equal(conversationSendProblem("c", send("x".repeat(CONVERSATION_MAX_MESSAGE_CHARS))), null);
  assert.match(conversationSendProblem("c", send("x".repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1))), /at most 200,000/);
  // Escaped control characters encode to six bytes each and still fit the frame cap by design.
  const escaped = "\u0001".repeat(CONVERSATION_MAX_MESSAGE_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify(send(escaped))) < CONVERSATION_MAX_CLIENT_FRAME_BYTES);
  assert.equal(conversationSendProblem("c", send(escaped)), null);
});

test("line and paragraph separators reach the desktop as plain line breaks", () => {
  assert.equal(
    plainLineBreaks("one two three\r\nfour\rfive\u0085six"),
    "one\ntwo\nthree\nfour\nfive\nsix",
  );
  assert.equal(plainLineBreaks("one line\nand another"), "one line\nand another");
});

test("a held send has landed only when a later user message carries its words as whole lines", () => {
  const message = (seq, text) => ({ type: "user_message", seq, payload: { text } });
  assert.equal(heldSendLanded(message(6, "draft the phone side"), "draft the phone side", 5), true);
  assert.equal(heldSendLanded(message(6, "check the gateway\ndraft the phone side"), "  draft the phone side\n", 5), true, "joined a line apiece, trimmed as the desktop holds it");
  assert.equal(heldSendLanded(message(5, "draft the phone side"), "draft the phone side", 5), false, "from before it was offered");
  assert.equal(heldSendLanded(message(6, "draft the phone sidebar"), "draft the phone side", 5), false, "part of a line is not the line");
  assert.equal(heldSendLanded({ type: "content_delta", seq: 9, payload: { text: "draft the phone side" } }, "draft the phone side", 5), false);
  assert.equal(heldSendLanded(message(6, "anything"), "   ", 5), false);
  assert.equal(heldSendLanded({ type: "user_message", payload: { text: "x" } }, "x", 0), false, "an event with no sequence cannot be placed");
});

test("a steer carries its words alone, and is refused before the outbox otherwise", () => {
  assert.equal(conversationSendProblem("c1", { kind: "send", message: "and add tests", steer: true }), null);
  assert.match(conversationSendProblem("c2", { kind: "send", message: "x", steer: true, queue: true }), /words alone/);
  assert.match(conversationSendProblem("c3", { kind: "send", message: "x", steer: true, uploadIds: [] }), /words alone/);
});

test("a lost session is read from its code, or from the runtime's own sentence where no code came with it", () => {
  assert.equal(conversationSessionWasLost({ ok: false, code: "session_not_found", message: "Gone." }), true);
  assert.equal(conversationSessionWasLost({ ok: false, code: "unavailable", message: "Conversation session is invalid." }), true);
  assert.equal(conversationSessionWasLost({ ok: false, message: "Conversation session is invalid." }), true);
  assert.equal(conversationSessionWasLost({ ok: false, code: "busy", message: "Conversation session is invalid." }), false);
  assert.equal(conversationSessionWasLost({ ok: true }), false);
});
