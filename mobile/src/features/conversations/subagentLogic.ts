// A chat's subagents as the phone lists them: the chats it started with
// `subagent.start` (named by the desktop, `conversation-subagents`) beside the
// agents its CLI spawned (read off its own transcript, `agentLogic.ts`). Each
// opens as a chat of its own, with a link back to its parent and only its own
// children listed under it, as the desktop's panel lists them
// (`subagentFamily.tsx`). No react-native import, so `node --test` can pin it.

import type {
  ConversationPhase,
  ConversationSubagent,
  ConversationSubagentStatus,
  ConversationThread,
} from "../../api/conversationWire";
import { formatDuration, formatElapsed, laneGlyphState, laneLabel, laneStatus, type AgentLane } from "./agentLogic";

export type SubagentTone = "working" | "waiting" | "failed" | "quiet";

const ENDED: ReadonlySet<ConversationSubagentStatus> = new Set(["completed", "failed", "stopped"]);

/** Whether a subagent chat's task has ended, as the desktop reads its status. */
export function subagentEnded(status: ConversationSubagentStatus): boolean {
  return ENDED.has(status);
}

/**
 * How a subagent chat stands, in the desktop's words (`SubagentStatusWords`):
 * "Waiting on you" in the warn tone, "Working · 42s" in the accent while it
 * runs, then "Done in 1m 4s", "Failed after 9s" (error ink) or "Stopped after
 * 3m".
 */
export function chatSubagentStatus(
  subagent: Pick<ConversationSubagent, "status" | "startedAt" | "endedAt">,
  now: number,
): { text: string; tone: SubagentTone } {
  const { status, startedAt, endedAt } = subagent;
  if (status === "needs_input") return { text: "Waiting on you", tone: "waiting" };
  if (!subagentEnded(status)) {
    // A task that ended and works again on a follow-up has no clock of its
    // task's to count.
    return endedAt === undefined
      ? { text: `Working · ${formatElapsed(now - startedAt)}`, tone: "working" }
      : { text: "Working", tone: "working" };
  }
  const took = endedAt === undefined ? undefined : formatDuration(Math.max(0, endedAt - startedAt));
  if (status === "failed") return { text: took ? `Failed after ${took}` : "Failed", tone: "failed" };
  if (status === "stopped") return { text: took ? `Stopped after ${took}` : "Stopped", tone: "quiet" };
  return { text: took ? `Done in ${took}` : "Done", tone: "quiet" };
}

/** What a subagent chat is called on its row and its screen. */
export function chatSubagentName(subagent: Pick<ConversationSubagent, "title" | "task">): string {
  return subagent.title.trim() || subagent.task.trim() || "Subagent";
}

const PHASES: Record<ConversationSubagentStatus, ConversationPhase> = {
  starting: "starting",
  working: "running",
  needs_input: "waiting_for_input",
  completed: "completed",
  failed: "failed",
  stopped: "idle",
};

/**
 * The thread a subagent chat opens as. It is a chat like any other on the
 * wire, followed by its own ids; the list leaves it out, so what the chat
 * screen needs of a listed thread is taken from its row, and where it runs
 * from its parent, which runs it on the same machine.
 */
export function subagentThread(subagent: ConversationSubagent, parent: ConversationThread): ConversationThread {
  return {
    workspaceId: subagent.workspaceId,
    agentId: subagent.agentId,
    title: chatSubagentName(subagent),
    phase: PHASES[subagent.status],
    createdAt: subagent.startedAt,
    updatedAt: subagent.endedAt ?? subagent.startedAt,
    providerId: subagent.providerId,
    modelId: subagent.modelId,
    turnCount: 0,
    lastSeq: 0,
    ...(subagent.sessionId ? { sessionId: subagent.sessionId } : {}),
    ...(subagent.permissionPreset ? { permissionPreset: subagent.permissionPreset } : {}),
    ...(subagent.capabilities ? { capabilities: subagent.capabilities } : {}),
    ...(parent.host ? { host: parent.host } : {}),
  };
}

/**
 * The chat a subagent chat was started from, which its screen links back to.
 * `main` when that chat is the one at the top, not a subagent itself.
 */
export type SubagentChatParent = { agentId: string; name: string; main: boolean };

/** Who a subagent's screen leads back to: the chat or agent it was started from. */
export type SubagentParent =
  | { kind: "chat"; agentId: string; name: string; main: boolean }
  | { kind: "lane"; laneId: string; name: string };

/** "Main chat" for the chat at the top, "Parent agent" for one between, as the desktop's card says. */
export function parentRelation(parent: SubagentParent): string {
  return parent.kind === "chat" && parent.main ? "Main chat" : "Parent agent";
}

/**
 * The agents a CLI spawned that belong directly to the chat (`parentLaneId`
 * absent) or to one of them: never a grandchild, which is read by going into
 * its own parent.
 */
export function directLanes(lanes: readonly AgentLane[], parentLaneId?: string): AgentLane[] {
  return lanes.filter((lane) => (parentLaneId === undefined ? !lane.parentId : lane.parentId === parentLaneId));
}

/** One row of a Subagents list. */
export type SubagentEntry =
  | { kind: "chat"; key: string; startedAt: number; working: boolean; subagent: ConversationSubagent }
  | { kind: "lane"; key: string; startedAt: number; working: boolean; lane: AgentLane };

/**
 * The Subagents list: the ones still working (or waiting on you) first, oldest
 * first, then the finished ones newest first, the two kinds side by side by
 * when each started. A lane's key is its spawning call's id, a chat's its
 * agent id, so the two never meet.
 */
export function subagentEntries(input: {
  lanes: readonly AgentLane[];
  subagents: readonly ConversationSubagent[];
}): { working: SubagentEntry[]; finished: SubagentEntry[] } {
  const entries: SubagentEntry[] = [
    ...input.subagents.map(
      (subagent): SubagentEntry => ({
        kind: "chat",
        key: `chat:${subagent.agentId}`,
        startedAt: subagent.startedAt,
        working: !subagentEnded(subagent.status),
        subagent,
      }),
    ),
    ...input.lanes.map(
      (lane): SubagentEntry => ({
        kind: "lane",
        key: `lane:${lane.id}`,
        startedAt: lane.startedAt,
        working: lane.status === "running",
        lane,
      }),
    ),
  ];
  const byStart = (a: SubagentEntry, b: SubagentEntry) => a.startedAt - b.startedAt;
  return {
    working: entries.filter((entry) => entry.working).sort(byStart),
    finished: entries
      .filter((entry) => !entry.working)
      .sort(byStart)
      .reverse(),
  };
}

/** A row's name and status words, whichever kind it is. */
export function subagentEntryWords(entry: SubagentEntry, now: number): { name: string; text: string; tone: SubagentTone } {
  if (entry.kind === "chat") return { name: chatSubagentName(entry.subagent), ...chatSubagentStatus(entry.subagent, now) };
  const status = laneStatus(entry.lane, now);
  return {
    name: entry.lane.task.trim() || laneLabel(entry.lane),
    text: status.text,
    tone: status.tone === "working" ? "working" : status.tone === "failed" ? "failed" : "quiet",
  };
}

/** "2 working · 3 finished", what the foot of the list says. */
export function subagentsFooter(working: number, finished: number): string {
  return [working ? `${working} working` : null, finished ? `${finished} finished` : null].filter(Boolean).join(" · ");
}

/** How many subagents a chat has and how many are working, for its page's row. */
export function subagentCounts(lanes: readonly AgentLane[], subagents: readonly ConversationSubagent[]): {
  total: number;
  working: number;
} {
  const top = directLanes(lanes);
  return {
    total: top.length + subagents.length,
    working:
      top.filter((lane) => laneGlyphState(lane) === "working").length +
      subagents.filter((subagent) => !subagentEnded(subagent.status)).length,
  };
}

/**
 * How many screens to go back to reach the route `matches` picks, the nearest
 * one under the top first; null when no screen under the top is it. A parent's
 * link pops back to the parent's own screen, so its socket, draft and place
 * are as they were left, rather than opening it a second time.
 */
export function stepsBackTo<Route>(routes: readonly Route[], matches: (route: Route) => boolean): number | null {
  for (let index = routes.length - 2; index >= 0; index--) if (matches(routes[index])) return routes.length - 1 - index;
  return null;
}

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  "kimi-code": "Kimi Code",
  "kimi-claude": "Kimi Code",
  muse: "Muse",
  zai: "Z.AI",
};

/** A harness as a person reads its name, as the desktop names it (`subagentIcon.tsx`). */
export function harnessName(cli: string): string {
  return HARNESS_NAMES[cli] ?? cli;
}

/** Whether a step is Studio's `subagent.start`, which the transcript draws as the subagent it started. */
export function isSubagentStart(tool: { name: string; serverName?: string }): boolean {
  const own = tool.serverName === "sprintengine-studio" || tool.name.includes("sprintengine-studio");
  return (own && tool.name.split(/__|[./]/u).at(-1) === "subagent_start") || tool.name.endsWith("subagent.start");
}

/**
 * What a `subagent.start` step says of what it started: the chat's id where
 * its answer came back (a long answer reaches the transcript cut, so the id is
 * looked for in the text as well), the harness it runs on (the chat's own
 * where the call named none), and the row's words, "Started a subagent ·
 * Cursor · muse-wonder-1.0 · Read-only", as the desktop's row says them.
 */
export function subagentStartFacts(
  tool: { input?: unknown; output?: unknown },
  chatCli: string | null,
): { subagentId: string | null; cli: string | null; words: string } {
  const input =
    tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)
      : {};
  const output = typeof tool.output === "string" ? tool.output : "";
  let subagentId: string | null = null;
  try {
    const parsed = JSON.parse(output) as { subagentId?: unknown };
    subagentId = typeof parsed.subagentId === "string" ? parsed.subagentId : null;
  } catch {
    subagentId = /"subagentId":\s*"([^"]+)"/u.exec(output)?.[1] ?? null;
  }
  const named = typeof input.cli === "string" && input.cli ? input.cli : null;
  const model = typeof input.cliModel === "string" ? input.cliModel.replace(/\[.*$/u, "") : null;
  const words = ["Started a subagent", named ? harnessName(named) : null, model, input.readOnly === true ? "Read-only" : null]
    .filter(Boolean)
    .join(" · ");
  return { subagentId, cli: named ?? chatCli, words };
}
