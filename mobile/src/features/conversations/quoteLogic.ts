// Quoting an agent's reply on the phone: the passage picked from the reply,
// carried in the draft as the desktop's own token (`shared/quotes`, a byte
// mirror of the desktop's `src/shared/chat-quotes.ts`), drawn as chips, and
// turned into words for a desktop that does not take tokens. No react-native
// import, so `node --test` can pin it.
//
// The phone's text box cannot hold a chip inside the words, so the draft keeps
// its quotes in front of them: `[Quote 1](…) [Quote 2](…) the words`. The
// composer draws the tokens as chips above the box and the box holds the words
// alone. A draft brought back with a token in the middle (an edited queued
// message) shows the same chips, and its words around them read on unchanged.

import {
  QUOTE_CONTEXT_CHARS,
  QUOTE_TOKEN_MAX_CHARS,
  collectQuotes,
  mayHoldQuotes,
  quoteToken,
  quotesToInlineText,
  quotesToReadableMarkdown,
  type ChatQuote,
  type ChatQuoteToken,
} from "../../shared/quotes/chat-quotes";

const fold = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Markdown as the page draws it, near enough to find a passage again: block
 * marks (headings, quotes, list bullets, fences) and inline marks (emphasis,
 * code spans, links and images) taken off, the words kept. The desktop finds
 * a quote by the words its reply drew, so a passage quoted here is marked
 * there too wherever this reads the reply as it reads it.
 */
export function markdownPlain(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const out: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(raw);
      continue;
    }
    out.push(
      raw
        .replace(/^ {0,3}#{1,6}\s+/u, "")
        .replace(/^ {0,3}(?:>\s?)+/u, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/(`+)([^`]*?)\1/gu, "$2")
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, "$2")
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*/gu, "$1$2")
        .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?=\W|$)/gu, "$1$2")
        .replace(/~~(?=\S)([\s\S]*?\S)~~/gu, "$1"),
    );
  }
  return out.join("\n");
}

/** Why a selection makes no quote, in words for the person; null when it makes one. */
export type QuoteRefusal = "empty" | "too_long";

/**
 * The quote a selection of `reply` makes: the passage, which the agent reads,
 * and its words folded with the words either side of it, which find it again
 * in the reply. The phone selects from the reply's drawn words (`drawn`, its
 * Markdown read by `markdownPlain`), so a person picks words as they read
 * them, not asterisks; the passage is then those words. Given the Markdown
 * itself, the passage is its Markdown, as the desktop's is. The occurrence
 * kept is the one nearest where the selection sits, so a phrase the reply
 * says twice is marked where it was picked.
 */
export function makeQuote(input: {
  turnId: string;
  reply: string;
  start: number;
  end: number;
  n: number;
  comment?: string;
  /** `reply` is already the drawn words, not Markdown. */
  drawn?: boolean;
}): { quote: ChatQuote } | { refused: QuoteRefusal } {
  const plain = input.drawn ? (text: string) => text : markdownPlain;
  const from = Math.max(0, Math.min(input.start, input.end));
  const to = Math.min(input.reply.length, Math.max(input.start, input.end));
  const passage = input.reply.slice(from, to).trim();
  if (!passage) return { refused: "empty" };
  const exact = fold(plain(passage));
  if (!exact) return { refused: "empty" };
  const drawn = fold(plain(input.reply));
  const aim = input.reply.length ? (from / input.reply.length) * drawn.length : 0;
  let at = -1;
  for (let found = drawn.indexOf(exact); found >= 0; found = drawn.indexOf(exact, found + 1))
    if (at < 0 || Math.abs(found - aim) < Math.abs(at - aim)) at = found;
  const quote: ChatQuote = {
    turnId: input.turnId,
    n: input.n,
    quote: passage,
    exact,
    prefix: at > 0 ? drawn.slice(Math.max(0, at - QUOTE_CONTEXT_CHARS), at) : "",
    suffix: at >= 0 ? drawn.slice(at + exact.length, at + exact.length + QUOTE_CONTEXT_CHARS) : "",
    comment: input.comment?.trim() ?? "",
  };
  return quoteToken(quote).length > QUOTE_TOKEN_MAX_CHARS ? { refused: "too_long" } : { quote };
}

/** The words a refusal says. */
export function quoteRefusalText(refusal: QuoteRefusal): string {
  return refusal === "empty"
    ? "Select the words to quote first."
    : "That passage is too long to quote. Select less of it.";
}

/** A draft as the composer draws it: its quotes as chips, and the words the box holds. */
export function splitQuoteDraft(text: string): { quotes: ChatQuoteToken[]; words: string } {
  if (!mayHoldQuotes(text)) return { quotes: [], words: text };
  const quotes = collectQuotes(text);
  if (!quotes.length) return { quotes, words: text };
  let words = "";
  let at = 0;
  for (const quote of quotes) {
    words += text.slice(at, quote.from);
    at = quote.to;
    // A chip is typed with the space after it; it goes with the chip.
    if (text[at] === " ") at++;
  }
  words += text.slice(at);
  return { quotes, words: words.replace(/^ +/u, "") };
}

/** The draft the box and its chips stand for: the quotes first, then the words. */
export function joinQuoteDraft(tokens: readonly string[], words: string): string {
  if (!tokens.length) return words;
  return words ? `${tokens.join(" ")} ${words}` : tokens.join(" ");
}

/**
 * A message as it goes to its desktop: with its quotes as tokens where the
 * desktop expands them for its agent (`conversation-quote-tokens`), and
 * otherwise as words, each passage a blockquote with its comment under it, the
 * words an older desktop's agent reads and its window shows.
 */
export function messageForDesktop(text: string, tokens: boolean): string {
  return tokens || !mayHoldQuotes(text) ? text : quotesToReadableMarkdown(text);
}

/** A message on one line (a scheduled message's row): each quote as its passage in quotation marks. */
export function messageInline(text: string): string {
  return mayHoldQuotes(text) ? quotesToInlineText(text) : text;
}

/** A person's message cut into what it says and the quotes it carries, in order. */
export type MessagePart = { kind: "words"; text: string } | { kind: "quote"; quote: ChatQuoteToken };
export function messageParts(text: string): MessagePart[] {
  const quotes = mayHoldQuotes(text) ? collectQuotes(text) : [];
  if (!quotes.length) return [{ kind: "words", text }];
  const parts: MessagePart[] = [];
  let at = 0;
  for (const quote of quotes) {
    if (quote.from > at) parts.push({ kind: "words", text: text.slice(at, quote.from) });
    parts.push({ kind: "quote", quote });
    at = quote.to;
  }
  if (at < text.length) parts.push({ kind: "words", text: text.slice(at) });
  return parts;
}

/**
 * Where a quote's passage is in a reply, by the reply's rows of the quote's
 * turn: the row's id and the passage's words, found again as the desktop finds
 * them. Null when the reply is not loaded or no longer says it.
 */
export function quoteSource<Row extends { kind: string; id: string; role?: string; turn?: string; text?: string }>(
  rows: readonly Row[],
  quote: Pick<ChatQuote, "turnId" | "exact">,
): Row | null {
  const exact = fold(quote.exact);
  const replies = rows.filter((row) => row.kind === "message" && row.role === "assistant" && row.turn === quote.turnId);
  return replies.find((row) => fold(markdownPlain(row.text ?? "")).includes(exact)) ?? replies[0] ?? null;
}
