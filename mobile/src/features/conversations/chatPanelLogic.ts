// The facts of a chat's page that are controls of their own, as the desktop's
// right-hand panel lists them under its activity (`ChatPanelFactRows.tsx`):
// branch, pull request, local servers, permissions, context and usage. Moved
// off the strip under the desktop's composer into its panel, they are rows of
// the phone's chat page here, in the phone's own words and shapes. No
// react-native import, so `node --test` can pin it.

import type {
  ConversationLocalServer,
  ConversationUsageLimitSnapshot,
  ConversationUsageLimitWindow,
} from "../../api/conversationWire";

/** "Server · dev-site · Running", or "3 servers · 2 running". Null with none. */
export function serverWords(servers: readonly ConversationLocalServer[] | undefined): { meta: string; sub: string } | null {
  if (!servers?.length) return null;
  const word = (state: ConversationLocalServer["state"]) =>
    state === "running" ? "Running" : state === "starting" ? "Starting" : "Stopped";
  if (servers.length === 1) {
    const [server] = servers;
    return { meta: word(server.state), sub: `${server.title || "Local server"} · port ${server.port}` };
  }
  const running = servers.filter((server) => server.state === "running").length;
  return {
    meta: running ? `${running} running` : "None running",
    sub: servers.map((server) => server.title || `port ${server.port}`).join(", "),
  };
}

// The plan a chat's CLI draws on, by the desktop's provider names.
const PLAN_OF_CLI: Readonly<Record<string, string>> = { "claude-code": "claude", codex: "codex" };

/**
 * The window a chat's Usage row reads: of the plan its CLI draws on (any plan
 * where none is known), the one nearest its limit, a refused one first. Null
 * where nothing is known.
 */
export function usageWindow(
  limits: readonly ConversationUsageLimitSnapshot[],
  cli: string | null,
): { plan: ConversationUsageLimitSnapshot; window: ConversationUsageLimitWindow } | null {
  const wanted = cli ? PLAN_OF_CLI[cli] : undefined;
  const plans = limits.filter((plan) => plan.windows.length && (!wanted || plan.provider === wanted));
  let best: { plan: ConversationUsageLimitSnapshot; window: ConversationUsageLimitWindow; weight: number } | null = null;
  for (const plan of plans)
    for (const window of plan.windows) {
      const weight = window.status === "rejected" ? 1_000 : (window.usedPercent ?? -1) + (window.status === "warning" ? 100 : 0);
      if (!best || weight > best.weight) best = { plan, window, weight };
    }
  return best ? { plan: best.plan, window: best.window } : null;
}

/** "42%", or "Limit reached" for a window that refuses, or "In use" where it says no share. */
export function usageMeta(window: ConversationUsageLimitWindow): string {
  if (window.status === "rejected") return "Limit reached";
  return window.usedPercent === null ? "In use" : `${Math.round(window.usedPercent)}%`;
}

/** "5-hour limit · resets 3:00 PM", what a window says under its share. */
export function usageSub(window: ConversationUsageLimitWindow, time: (at: number) => string): string {
  return [window.label, window.resetsAt !== null ? `resets ${time(window.resetsAt)}` : null].filter(Boolean).join(" · ");
}

/** The tone a window's share is said in: the warn tone near its limit, the error's at it. */
export function usageTone(window: ConversationUsageLimitWindow): "muted" | "warn" | "error" {
  if (window.status === "rejected") return "error";
  return window.status === "warning" || (window.usedPercent ?? 0) >= 80 ? "warn" : "muted";
}
