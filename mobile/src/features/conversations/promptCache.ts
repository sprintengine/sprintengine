// A chat's prompt cache as the phone says it. The reading is folded from the
// chat's events by the shared projection (`conversation-timeline`'s
// promptCache.ts), the one the desktop folds, so the phone and the desk say the
// same thing about the same conversation; this file says it.
//
// The API keeps a conversation's prefix cached for a fixed lifetime after the
// last request that touched it: five minutes by default, an hour when asked
// for. Inside that window the next message re-reads the conversation cheaply;
// past it, the whole conversation is written again at full price. For a long
// chat that is hundreds of thousands of tokens, which is why the notice above
// the composer offers a compaction while the cache is still warm.
//
// The reading is derived from events and a clock and never stored, so a chat
// whose desktop went quiet still goes cold on time.

import type { PromptCacheReading, PromptCacheTtl } from "../../../../packages/conversation-protocol/src/public";

export type PromptCacheState =
  | { kind: "warm"; remainingMs: number; recacheTokens: number | null }
  | { kind: "expiring"; remainingMs: number; recacheTokens: number | null }
  | { kind: "cold"; expiredAt: number | null; recacheTokens: number | null };

// Long enough before it goes cold to act on: a five-minute cache would be
// "expiring" for most of its life, so only its last two minutes count.
const EXPIRING_WITHIN_MS: Readonly<Record<PromptCacheTtl, number>> = {
  "5m": 2 * 60_000,
  "1h": 10 * 60_000,
};
/** Below this, re-caching is cheap enough not to mention. */
export const PROMPT_CACHE_NOTICE_TOKENS = 50_000;

export function promptCacheState(
  reading: PromptCacheReading | null | undefined,
  now: number,
): PromptCacheState | null {
  if (!reading) return null;
  const { expiresAt, recacheTokens } = reading;
  if (expiresAt !== null && expiresAt > now) {
    const remainingMs = expiresAt - now;
    const window = EXPIRING_WITHIN_MS[reading.ttl ?? "1h"];
    return { kind: remainingMs <= window ? "expiring" : "warm", remainingMs, recacheTokens };
  }
  return { kind: "cold", expiredAt: expiresAt, recacheTokens };
}

/** Going or gone, and big enough that re-caching matters. An unknown size is not assumed big. */
export function promptCacheNeedsAttention(
  state: PromptCacheState | null,
): state is Exclude<PromptCacheState, { kind: "warm" }> {
  return (
    state !== null &&
    state.kind !== "warm" &&
    (state.recacheTokens ?? 0) >= PROMPT_CACHE_NOTICE_TOKENS
  );
}

// 950 → "950", 12_345 → "12.3k", 412_000 → "412k", 1_200_000 → "1.2M".
export function formatTokenCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  const [scaled, unit] = value < 999_500 ? [value / 1000, "k"] : [value / 1_000_000, "M"];
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`;
}

// "8m", or "under a minute" where the minutes have nothing to say.
function minutes(ms: number): string {
  const whole = Math.floor(Math.max(0, ms) / 60_000);
  if (whole < 1) return "under a minute";
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The notice's words: the desktop's, so both surfaces say the same thing. */
export function promptCacheCopy(
  state: Exclude<PromptCacheState, { kind: "warm" }>,
  now: number,
): { label: string; detail: string } {
  const tokens =
    state.recacheTokens !== null
      ? `~${formatTokenCount(state.recacheTokens)} tokens`
      : "the whole conversation";
  if (state.kind === "expiring")
    return {
      label: `Cache expires in ${minutes(state.remainingMs)}`,
      detail: `After that, the next message re-sends ${tokens} uncached. Compacting now, while the cache is warm, is cheap.`,
    };
  const ago = state.expiredAt !== null && now - state.expiredAt >= 60_000 ? minutes(now - state.expiredAt) : "";
  return {
    label: ago ? `Cache expired ${ago} ago` : "Cache cold",
    // Compacting a cold cache re-reads the conversation uncached too; what it
    // buys is every message after it.
    detail: `The next message re-sends ${tokens} uncached, a compaction included. Compacting first makes every message after it smaller.`,
  };
}

/**
 * The same reading as one line, for the composer's tray: "Cache expires in 1m
 * · ~198k tokens cached", or "Cache expired 13m ago · ~198k tokens uncached".
 * The tray has a row, not a card, so the explanation `promptCacheCopy` gives
 * is left to its Compact action.
 */
export function promptCacheLine(state: Exclude<PromptCacheState, { kind: "warm" }>, now: number): string {
  const { label } = promptCacheCopy(state, now);
  if (state.recacheTokens === null) return label;
  const tokens = `~${formatTokenCount(state.recacheTokens)} tokens`;
  return `${label} · ${tokens} ${state.kind === "expiring" ? "cached" : "uncached"}`;
}

/** What a "Not now" is about: this reading. The next request writes a new one. */
export function promptCacheReadingKey(reading: PromptCacheReading): string {
  return `${reading.expiresAt ?? "cold"}:${reading.recacheTokens ?? ""}`;
}
