// A chat's subagents as the phone lists them: the chats it started with
// `subagent.start` (named by the desktop, `conversation-subagents`) beside the
// agents its CLI spawned (the lanes `conversation-timeline`'s rows read off its
// transcript). Each opens as a chat of its own, with a link back to its parent
// and only its own children listed under it, as the desktop's panel lists them
// (`subagentFamily.tsx`). No react-native import, so `node --test` can pin it.

import {
  type ConversationSubagent,
  type ConversationSubagentStatus,
  type ConversationListedThread as ConversationThread,
} from "../../../../packages/conversation-protocol/src/public";
import type { AgentLane } from "../../../../packages/conversation-timeline/src/public";
import { formatTokenCount } from "./promptCache";

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

const PHASES: Record<ConversationSubagentStatus, ConversationThread["phase"]> = {
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

// ── The agents its CLI spawned ──────────────────────────────────────────────
// How a lane reads on the phone: its status in words, its line in a list, the
// Agents screen's totals. Ported from the studio's chat (subagentStatus.tsx,
// subagentResult.tsx and the Agents tab) so a lane says the same words on both
// surfaces.

/** "Explore agent", or "Agent" when the call named no type. */
export function laneLabel(lane: Pick<AgentLane, 'subagentType'>): string {
  const type = lane.subagentType?.trim()
  return type ? `${type} agent` : 'Agent'
}

export type AgentGlyphState = 'working' | 'done' | 'failed' | 'stopped' | 'unknown'
export function laneGlyphState(lane: AgentLane): AgentGlyphState {
  if (lane.status === 'running') return 'working'
  if (lane.agent?.state === 'failed' || lane.outcome === 'error') return 'failed'
  if (lane.agent?.state === 'stopped' || lane.outcome === 'stopped' || lane.outcome === 'declined') return 'stopped'
  if (lane.agent?.state === 'unknown') return 'unknown'
  return 'done'
}

/**
 * How long a step or an agent took, on one clock: tenths under a second,
 * whole seconds under a minute, then minutes and seconds ("1m 29s"). A whole
 * minute drops its "0s".
 */
export function formatDuration(ms: number): string {
  if (ms < 950) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  // Rounded once, before it is split: 1m 59.7s must not read "1m 60s".
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const rest = seconds % 60
  return rest ? `${Math.floor(seconds / 60)}m ${rest}s` : `${Math.floor(seconds / 60)}m`
}
/** A running clock: whole seconds from the first, since the first seconds are the interesting ones. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
/** "45k tokens", "900 tokens". */
export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} tokens`
}

function laneDurationMs(lane: AgentLane): number | undefined {
  if (lane.completedAt !== undefined) return Math.max(0, lane.completedAt - lane.startedAt)
  return lane.agent?.usage?.durationMs || undefined
}

/**
 * Where an agent stands, in words and ink: "Working · 42s" in the accent
 * while it runs; "Done in 1m 29s", "Failed after 9s" (error ink), "Stopped
 * after 3m", or "Ran in the background" for one whose end was never recorded.
 */
export function laneStatus(lane: AgentLane, now: number): { text: string; tone: 'working' | 'failed' | 'quiet' } {
  const state = laneGlyphState(lane)
  if (state === 'working') return { text: `Working · ${formatElapsed(now - lane.startedAt)}`, tone: 'working' }
  if (state === 'unknown') return { text: 'Ran in the background', tone: 'quiet' }
  const duration = laneDurationMs(lane)
  const took = duration !== undefined ? formatDuration(duration) : undefined
  if (lane.outcome === 'declined') return { text: 'Declined', tone: 'quiet' }
  if (state === 'failed') return { text: took ? `Failed after ${took}` : 'Failed', tone: 'failed' }
  if (state === 'stopped') return { text: took ? `Stopped after ${took}` : 'Stopped', tone: 'quiet' }
  return { text: took ? `Done in ${took}` : 'Done', tone: 'quiet' }
}

/** What it is doing right now, while it runs: its own summary, else its latest tool. */
export function laneNow(lane: AgentLane): string {
  if (lane.status !== 'running') return ''
  return lane.agent?.progressSummary ?? (lane.agent?.lastToolName ? `using ${lane.agent.lastToolName}` : '')
}

/** The report's first line of prose, with the markdown that opens it dropped. */
export function reportPreview(report: string | undefined): string {
  const line = report?.split(/\r?\n/u).find((candidate) => candidate.trim()) ?? ''
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/u, '')
    .replace(/^(\*\*|__)(.+)\1$/u, '$2')
    .trim()
}

/** The line under an agent in a list: what it is doing now, why it failed, or what it found. */
export function laneDetail(lane: AgentLane): { text: string; error: boolean } {
  if (lane.status === 'running') {
    const now = laneNow(lane)
    return { text: now ? `Now: ${now}` : '', error: false }
  }
  if (lane.agent?.error) return { text: lane.agent.error, error: laneGlyphState(lane) === 'failed' }
  return { text: reportPreview(lane.report), error: false }
}

/** How many steps it took: what it reported, else the calls seen. */
export function laneStepCount(lane: AgentLane): number {
  return lane.agent?.usage?.toolUses || lane.steps.length
}

/**
 * Where an agent's own words go in its thread: each before the first step it
 * started after, as a turn's prose sits before the tools it explains, and the
 * rest after the last step. The last thing a finished agent says is its
 * report, which the thread shows as the report, so it is not said twice.
 */
export function placeAgentMessages(lane: AgentLane): {
  beforeSteps: { text: string; beforeToolUseId: string }[]
  afterSteps: string[]
} {
  const beforeSteps: { text: string; beforeToolUseId: string }[] = []
  const afterSteps: string[] = []
  for (const message of lane.messages) {
    const next = lane.steps.find((step) => step.startedAt !== undefined && step.startedAt > message.at)
    if (next) beforeSteps.push({ text: message.text, beforeToolUseId: next.id })
    else afterSteps.push(message.text)
  }
  const report = lane.report?.trim()
  const last = afterSteps.at(-1)?.trim()
  if (lane.status !== 'running' && report && last && report.startsWith(last.slice(0, 200))) afterSteps.pop()
  return { beforeSteps, afterSteps }
}

/**
 * The Agents screen: the ones still working, then the finished ones newest
 * first, and the footer's totals ("2 working · 3 finished · 45k tokens").
 */
export function summarizeAgents(lanes: AgentLane[]): {
  working: AgentLane[]
  finished: AgentLane[]
  tokens: number
  footer: string
} {
  const working = lanes.filter((lane) => lane.status === 'running')
  const finished = lanes.filter((lane) => lane.status !== 'running').reverse()
  const tokens = lanes.reduce((sum, lane) => sum + (lane.agent?.usage?.totalTokens ?? 0), 0)
  const footer = [
    working.length ? `${working.length} working` : null,
    finished.length ? `${finished.length} finished` : null,
    tokens ? formatTokens(tokens) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return { working, finished, tokens, footer }
}

/** The working line's words: "2 subagents working" while they run, else "Working". */
export function workingLabel(lanes: AgentLane[]): string {
  const running = lanes.filter((lane) => lane.status === 'running').length
  if (!running) return 'Working'
  return `${running} ${running === 1 ? 'subagent' : 'subagents'} working`
}

/**
 * The working line once the turn is over and something still works: "2
 * agents working in background", or "Working in background" for a monitor
 * that will wake the agent. The agents are the more of those the transcript
 * shows running and those the desktop lists (`listedAgents`), since either
 * may be ahead of the other.
 */
export function backgroundWorkLabel(lanes: AgentLane[], listedAgents = 0): string {
  const running = Math.max(lanes.filter((lane) => lane.status === 'running').length, listedAgents)
  if (!running) return 'Working in background'
  return `${running} ${running === 1 ? 'subagent' : 'subagents'} working in background`
}

// Said for the agents every Claude session has, when the session has not
// described them itself.
const BUILT_IN_AGENT_TYPES: Record<string, string> = {
  Explore: 'A read-only helper that searches the code and reports back.',
  Plan: 'A read-only helper that works out an approach before anything changes.',
  'general-purpose': 'A helper that takes on part of the task in parallel, with the same tools as the main agent.',
}
/** What an agent of this type is for, in a sentence, when anything says. */
export function agentTypeDescription(type: string | undefined, described: Record<string, string>): string | undefined {
  if (!type) return undefined
  const text = described[type] ?? BUILT_IN_AGENT_TYPES[type]
  if (!text) return undefined
  // A provider's description is written for the model choosing an agent and
  // runs long; its first sentence says what the agent is.
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/u.exec(text.trim())?.[0] ?? text.trim()
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}

/**
 * What the agent's own Stop offers, or null where it offers none: an agent
 * that has ended, a desktop that cannot stop one by itself
 * (`conversation-stop-subagent`) or a pairing that may only follow, and a
 * chat whose CLI cannot (its listed `capabilities.stopSubagent`). The
 * desktop's turn Stop spares a chat's agents where this one is offered, so it
 * is the only way to stop one from the phone. Taken, it says "Stopping" until
 * the agent reports its end; with the chat offline it waits for the link.
 */
export function agentStopOffer(
  lane: Pick<AgentLane, 'status'>,
  chat: { stopsAgents: boolean; chatCanStop: boolean; live: boolean; stopping: boolean },
): { label: string; disabled: boolean } | null {
  if (lane.status !== 'running' || !chat.stopsAgents || !chat.chatCanStop) return null
  if (chat.stopping) return { label: 'Stopping…', disabled: true }
  return { label: 'Stop this subagent', disabled: !chat.live }
}

/**
 * Whether the person can write to an agent, the phone's reading of the desktop's
 * rule (subagentDelivery.ts): a box only where a message arrives, and otherwise
 * no box, only the way to the chat and why. A running agent and a finished one
 * take a message; one the person stopped is refused by its CLI, and nothing
 * proved one that failed or whose end was not recorded.
 */
export function agentMessageOffer(
  lane: Pick<AgentLane, 'status' | 'outcome' | 'agent'>,
  chat: { messagesAgents: boolean; chatCanMessage: boolean | undefined },
): { kind: 'box' } | { kind: 'bar'; why: string } {
  if (!chat.messagesAgents) return { kind: 'bar', why: 'This desktop cannot pass a message to a subagent from here.' }
  if (chat.chatCanMessage === undefined)
    return { kind: 'bar', why: 'The chat is at rest, and has not said whether it can pass a message on.' }
  if (!chat.chatCanMessage) return { kind: 'bar', why: 'This chat has no way to pass a message to a subagent.' }
  if (lane.agent?.canContinue === false) return { kind: 'bar', why: 'Its harness says it cannot be continued.' }
  if (!lane.agent?.taskId)
    return {
      kind: 'bar',
      why:
        lane.status === 'running'
          ? 'It has not started yet, so a message has nowhere to go.'
          : 'Its harness gave no way to reach this one.',
    }
  if (lane.outcome === 'declined') return { kind: 'bar', why: 'It was declined before it ran.' }
  const state = lane.agent.state
  if (state === 'running' || state === 'completed') return { kind: 'box' }
  if (state === 'stopped') return { kind: 'bar', why: 'It was stopped, and a stopped agent cannot be continued.' }
  if (state === 'failed') return { kind: 'bar', why: 'It failed, and nothing says it can be continued.' }
  return { kind: 'bar', why: 'How it ended was never recorded, so nothing says it can be continued.' }
}
