/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  joinQuoteDraft,
  makeQuote,
  markdownPlain,
  messageForDesktop,
  messageInline,
  messageParts,
  quoteSource,
  splitQuoteDraft,
} = require("../../../.mobile-test-build/src/features/conversations/quoteLogic.js");
const quotes = require("../../../.mobile-test-build/src/shared/quotes/chat-quotes.js");
const { messageCopyText } = require("../../../.mobile-test-build/src/features/conversations/copyText.js");

const repoRoot = path.resolve(__dirname, "../../../..");

test("the quote token module is the desktop's, byte for byte", () => {
  assert.equal(
    fs.readFileSync(path.join(repoRoot, "mobile/src/shared/quotes/chat-quotes.ts"), "utf8"),
    fs.readFileSync(path.join(repoRoot, "src/shared/chat-quotes.ts"), "utf8"),
    "copy src/shared/chat-quotes.ts over mobile/src/shared/quotes/chat-quotes.ts, then re-run",
  );
});

const reply = "First, **the cache** is cold.\n\n- Then the `loader` runs twice.\n- Then the cache is warm.";

test("a selection makes the desktop's quote: its Markdown, its drawn words, and the words around it", () => {
  const start = reply.indexOf("the `loader`");
  const made = makeQuote({ turnId: "t-7", reply, start, end: start + "the `loader` runs twice".length, n: 3 });
  assert.ok("quote" in made);
  assert.equal(made.quote.quote, "the `loader` runs twice");
  assert.equal(made.quote.exact, "the loader runs twice");
  assert.equal(made.quote.prefix.endsWith("is cold. Then "), true);
  assert.equal(made.quote.suffix.startsWith(". Then the cache"), true);
  assert.equal(made.quote.n, 3);
  // The desktop finds it again in the drawn words.
  assert.ok(quotes.locateQuote("First, the cache is cold. Then the loader runs twice. Then the cache is warm.", made.quote));
});

test("a phrase said twice is the occurrence that was picked", () => {
  const start = reply.lastIndexOf("the cache");
  const made = makeQuote({ turnId: "t", reply, start, end: start + "the cache".length, n: 1 });
  assert.equal(made.quote.suffix.startsWith(" is warm"), true);
  const first = makeQuote({ turnId: "t", reply, start: reply.indexOf("the cache"), end: reply.indexOf("the cache") + 9, n: 1 });
  assert.equal(first.quote.suffix.startsWith(" is cold"), true);
});

test("nothing selected, or too much, makes no quote", () => {
  assert.deepEqual(makeQuote({ turnId: "t", reply, start: 4, end: 4, n: 1 }), { refused: "empty" });
  assert.deepEqual(makeQuote({ turnId: "t", reply: "   ", start: 0, end: 3, n: 1 }), { refused: "empty" });
  const huge = "é".repeat(20_000);
  assert.deepEqual(makeQuote({ turnId: "t", reply: huge, start: 0, end: huge.length, n: 1 }), { refused: "too_long" });
});

test("Markdown reads as the words it draws", () => {
  assert.equal(markdownPlain("## Title\n> quoted *word* and __strong__\n1. [link](https://x.example) `code`"), "Title\nquoted word and strong\nlink code");
  assert.equal(markdownPlain("keep snake_case_names and 2*3*4"), "keep snake_case_names and 2*3*4");
  assert.equal(markdownPlain("```ts\nconst a = 1\n```"), "const a = 1");
});

const token = (n, comment = "") => quotes.quoteToken({ turnId: "t", n, quote: `passage ${n}`, exact: `passage ${n}`, prefix: "", suffix: "", comment });

test("the composer draws a draft's quotes as chips and its words in the box", () => {
  const draft = `${token(1)} ${token(2)} why does it run twice?`;
  const split = splitQuoteDraft(draft);
  assert.deepEqual(split.quotes.map((quote) => quote.n), [1, 2]);
  assert.equal(split.words, "why does it run twice?");
  assert.equal(joinQuoteDraft(split.quotes.map((quote) => quote.token), split.words), draft, "typing round-trips");
  assert.equal(joinQuoteDraft([token(1)], ""), token(1));
  assert.deepEqual(splitQuoteDraft("plain words"), { quotes: [], words: "plain words" });
  // A token mid-sentence (an edited queued message) keeps its words around it.
  assert.equal(splitQuoteDraft(`see ${token(4)} and fix it`).words, "see and fix it");
});

test("a quote goes as its token only where the desktop takes one", () => {
  const message = `${token(1, "this one")} why?`;
  assert.equal(messageForDesktop(message, true), message);
  const words = messageForDesktop(message, false);
  assert.equal(words.includes("sprintengine-quote:"), false, "never the address");
  assert.match(words, /^> passage 1\n\nthis one\n\nwhy\?$/u);
  assert.equal(messageForDesktop("no quotes", false), "no quotes");
  assert.equal(messageInline(message), "“passage 1” (this one) why?");
  assert.equal(messageCopyText(message).includes("sprintengine-quote:"), false, "Copy message copies the words");
});

test("a sent message is cut into its words and its quotes, in order", () => {
  const parts = messageParts(`before ${token(1)} after`);
  assert.deepEqual(parts.map((part) => part.kind), ["words", "quote", "words"]);
  assert.equal(parts[1].quote.n, 1);
  assert.deepEqual(messageParts("only words"), [{ kind: "words", text: "only words" }]);
});

test("Go to source finds the reply that holds the passage in the quote's turn", () => {
  const rows = [
    { kind: "message", id: "a", role: "assistant", turn: "t-1", text: "unrelated" },
    { kind: "message", id: "b", role: "assistant", turn: "t-2", text: "Intro." },
    { kind: "message", id: "c", role: "assistant", turn: "t-2", text: "The **loader** runs twice." },
  ];
  assert.equal(quoteSource(rows, { turnId: "t-2", exact: "loader runs twice" }).id, "c");
  assert.equal(quoteSource(rows, { turnId: "t-2", exact: "gone now" }).id, "b", "its turn, where the words moved");
  assert.equal(quoteSource(rows, { turnId: "t-9", exact: "x" }), null);
});
