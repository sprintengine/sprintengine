import { parseChatLink, type ChatLink } from "../../../../packages/studio-protocol/src/chat-link";
import {
  presentToolItem,
  type ConversationEvent as ProjectedEvent,
  type ConversationListedThread as ConversationThread,
  type ConversationToolKind,
  type ConversationWireEvent as ConversationEvent,
} from "../../../../packages/conversation-protocol/src/public";
import {
  deriveConversationRows,
  projectConversation,
  turnFoldLabel as sharedTurnFoldLabel,
  type ConversationProjection,
  type ConversationProjectionOptions,
  type ConversationRow,
  type ConversationRows,
  type ConversationRowsOptions,
  type ReplyClock,
  type RowTool,
  type TurnChanges,
  type TurnRetry,
  type UserTurn,
} from "../../../../packages/conversation-timeline/src/public";
import type { PhoneChatOffers } from "../../api/chatOffers";
import { cliForChatProvider, offeredPermissionPresets, PERMISSION_PRESET_OPTIONS } from "./launchLogic";
import { applyContextEvent, type ContextReading } from "./contextUsage";
import { keepUnchanged } from "./keepUnchanged";
import { formatDuration, isSubagentStart } from "./subagentLogic";
import { formatTokenCount } from "./promptCache";
import { parseSentImages } from "./sentPhotos";
import { withoutStudioNoticePrefix } from "./studioNotice";

/**
 * How long the composer's button stays Send after a send, before an empty box
 * lets it turn into Stop.
 */
export const SEND_SETTLE_MS = 1_500;

/**
 * Whether the composer's one button is Send or Stop. It is Stop only when the
 * box is empty, a reply runs that can be stopped, and nothing a finger is in
 * the middle of could have meant Send: not while the microphone listens (its
 * words lag the voice, so the box can be empty under a sentence being said),
 * not while a send waits on it, and not just after a send has emptied the
 * box. A second tap of Send there landed on Stop and broke off the reply the
 * message had just gone to.
 */
export function composerActionKind(input: {
  hasText: boolean;
  stoppable: boolean;
  dictating: boolean;
  sending: boolean;
  justSent: boolean;
}): "send" | "stop" {
  if (input.hasText || !input.stoppable) return "send";
  return input.dictating || input.sending || input.justSent ? "send" : "stop";
}

export type ConversationTarget = { deviceId: string; thread: ConversationThread };
export type ConversationLink = { deviceId: string; workspaceId: string; agentId: string };
/** Links identify a paired desktop; they never carry credentials or a server URL. */
export function parseConversationLink(value: string): ConversationLink | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "sprintengine:" || url.hostname !== "conversation" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 3 || parts.some((part) => !part || part.length > 200 || /[\u0000-\u001f]/.test(part))) return null;
    return { deviceId: parts[0], workspaceId: parts[1], agentId: parts[2] };
  } catch { return null; }
}

/**
 * A Studio chat link, `sprintengine://chat/<environmentId>/<chatId>[?agent=<agentId>]`,
 * which a desktop's "Copy link to chat" writes: the grammar is the protocol
 * package's (`chat-link.ts`), read here exactly as the desktop reads it. A
 * link from before links named an environment has none, and the phone looks
 * for its chat on every paired desktop.
 */
export type { ChatLink };

/** What a `sprintengine://` link opens: a conversation on a named desktop, or a Studio chat link. */
export type AppLink = { kind: "conversation"; link: ConversationLink } | { kind: "chat"; link: ChatLink };

export function parseAppLink(value: string): AppLink | null {
  const conversation = parseConversationLink(value);
  if (conversation) return { kind: "conversation", link: conversation };
  const chat = parseChatLink(value);
  return chat ? { kind: "chat", link: chat } : null;
}
export const stringValue = (value: unknown) => typeof value === "string" ? value : "";
export const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Sequence is authoritative; ids also deduplicate pre-sequence legacy history. */
export function mergeConversationEvents(current: ConversationEvent[], incoming: ConversationEvent[]) {
  if (incoming.length === 1) {
    const appended = appendNewest(current, incoming[0]);
    if (appended) return appended;
  }
  const ids = new Set(current.map((event) => event.id));
  const seqs = new Set(current.flatMap((event) => event.seq === undefined ? [] : [event.seq]));
  const added = incoming.filter((event) => {
    if (ids.has(event.id) || (event.seq !== undefined && seqs.has(event.seq))) return false;
    ids.add(event.id);
    if (event.seq !== undefined) seqs.add(event.seq);
    return true;
  });
  return added.length ? [...current, ...added].sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt)) : current;
}

/**
 * The events a running turn sends at the rate the model writes: a reply's
 * words, its thinking, a step's output. Each changes a row already drawn and
 * nothing else on the screen, so the screen may take several in one draw.
 * Anything else (a message arriving, a turn ending, a request for the
 * person) is drawn the moment it lands, with what the screen does about it.
 */
const STREAMED_EVENT_TYPES = new Set(["content_delta", "reasoning_delta", "tool_output"]);
export const isStreamedEvent = (event: Pick<ConversationEvent, "type">) => STREAMED_EVENT_TYPES.has(event.type);

/**
 * The live case, one event newer than everything held, merged in one pass
 * over the log with nothing built and nothing sorted: what the general merge
 * returns for it, which on a long chat's log cost several times the whole
 * projection. Null where the general merge must decide (a log out of order,
 * an event that sorts before its end).
 */
function appendNewest(current: ConversationEvent[], event: ConversationEvent): ConversationEvent[] | null {
  let last = -Infinity;
  for (const held of current) {
    if (held.id === event.id || (event.seq !== undefined && held.seq === event.seq)) return current;
    const key = held.seq ?? held.createdAt;
    if (!(key >= last)) return null;
    last = key;
  }
  return (event.seq ?? event.createdAt) >= last ? [...current, event] : null;
}

// ── The chat's rows ────────────────────────────────────────────────────────
// A chat's events become entries in the projection every client folds
// (`conversation-timeline`), and entries become the phone's rows in that
// package's narrow layout. What the phone asks for differently is said here.

/** How the phone reads a chat's events where the window reads them otherwise: a session's end settles its work. */
export const PHONE_PROJECTION: ConversationProjectionOptions = { sessionEndSettlesWork: true };

/**
 * How the phone lays the rows out: durations on its own clock, a Studio
 * subagent's start kept in view, its reading of a sent picture, and Studio's
 * notices without the name they open with.
 */
export const PHONE_ROWS: ConversationRowsOptions = {
  formatDuration,
  staysInView: isSubagentStart,
  sentImages: parseSentImages,
  studioNoticeText: withoutStudioNoticePrefix,
};

/** Sends the phone has not seen echoed are its courier's, never the projection's. */
export const NO_LOCAL_TURNS: UserTurn[] = [];

/** What the chat screen reads off a chat's events. */
export type PhoneConversation = ConversationRows & {
  /** How much of the model's context window the chat holds; null until a report says. */
  context: ContextReading | null;
};

/** The phone's rows for a projection, with the context ring's reading beside them. */
export function phoneRows(projection: ConversationProjection, context: ContextReading | null): PhoneConversation {
  return { ...deriveConversationRows(projection, PHONE_ROWS), context };
}

/**
 * The phone's events as the projection folds them. They are the wire's, whose
 * `type` is any string so that a newer desktop's event decodes: one of a type
 * this build does not know folds to nothing, as the projection has no case for
 * it, which is what the phone wants of it.
 */
export function foldable(events: readonly ConversationEvent[]): readonly ProjectedEvent[] {
  return events as readonly ProjectedEvent[];
}

/** A chat's events as the phone draws them, folded whole. */
export function projectPhoneConversation(events: readonly ConversationEvent[]): PhoneConversation {
  return phoneRows(
    projectConversation(foldable(events), NO_LOCAL_TURNS, PHONE_PROJECTION),
    events.reduce<ContextReading | null>(applyContextEvent, null),
  );
}

/** The context ring's reading over a log, and the log it was read over. */
export type HeldContext = { events: readonly ConversationEvent[]; reading: ContextReading | null };

/**
 * The context ring's reading after `events`: carried on from `held` when the
 * log only grew past what it was read over, read whole otherwise (an earlier
 * page, another chat).
 */
export function followContext(held: HeldContext | null, events: readonly ConversationEvent[]): HeldContext {
  const length = held?.events.length ?? 0;
  const grew = held !== null && length > 0 && events.length >= length && events[length - 1] === held.events[length - 1];
  if (grew && events.length === length) return held;
  let reading = grew ? held.reading : null;
  for (let index = grew ? length : 0; index < events.length; index++) reading = applyContextEvent(reading, events[index]);
  return { events, reading };
}

/** "Worked for 2m 14s · 12 steps", on the phone's clock. */
export function turnFoldLabel(
  state: { status: "streaming" | "complete" | "failed" | "interrupted"; durationMs?: number },
  steps: number,
): string {
  return sharedTurnFoldLabel(state, steps, formatDuration);
}

/**
 * A new projection's rows, keeping each row that reads as it did as the
 * object it was. Every projection builds every row afresh, so without this a
 * streamed delta handed the list 600 new rows to draw for the one that
 * changed; a row kept as it was is skipped by its memo.
 */
export function keepUnchangedRows(previous: readonly ConversationRow[], next: ConversationRow[]): ConversationRow[] {
  return keepUnchanged(previous, next, (row) => row.id);
}

// ── Retries ────────────────────────────────────────────────────────────────

/**
 * The working line while the provider waits to retry a failed call: what went
 * wrong, and how far through its attempts it is ("Couldn't authenticate ·
 * retrying (3 of 10)…"). The reason leads because it is the one thing a
 * person can act on: an expired sign-in, a limit.
 */
export function retryLabel(retry: Pick<TurnRetry, "attempt" | "maxAttempts" | "error" | "status">): string {
  return `${retryReason(retry)} · retrying (${retry.attempt} of ${retry.maxAttempts})…`;
}
function retryReason({ error, status }: Pick<TurnRetry, "error" | "status">): string {
  switch (error) {
    case "authentication_failed":
      return "Couldn\u2019t authenticate";
    case "rate_limit":
      return "Rate limited";
    case "overloaded":
      return "Service overloaded";
    case "server_error":
      return "Server error";
    case "billing_error":
      return "Billing problem";
  }
  if (status === 401 || status === 403) return "Couldn\u2019t authenticate";
  if (status === 429) return "Rate limited";
  if (status === 529) return "Service overloaded";
  // No response at all: the request never reached the service.
  if (status === undefined) return "Couldn\u2019t connect";
  return `Request failed (${status})`;
}

// ── Turn folds ─────────────────────────────────────────────────────────────

/** "3 files changed · +42 −7". */
export function turnChangesLabel(changes: TurnChanges): string {
  const files = `${changes.files} ${changes.files === 1 ? "file" : "files"} changed`;
  const lines =
    changes.addedLines !== undefined && changes.removedLines !== undefined
      ? `+${changes.addedLines} \u2212${changes.removedLines}`
      : "";
  return [files, lines].filter(Boolean).join(" · ");
}

// ── Quiet tool steps ───────────────────────────────────────────────────────

function basename(path: string) {
  return path.split(/[\\/]/).at(-1) || path;
}
/**
 * One step as a quiet row draws it: the kind's glyph, a verb ("Read",
 * "Searching"), the thing it acted on in mono, and at the end how it went
 * wrong, when it did. A non-zero exit counts as going wrong.
 */
export function toolStep(tool: RowTool): {
  kind: ConversationToolKind;
  label: string;
  detail: string;
  end: string;
  failed: boolean;
  live: boolean;
} {
  const presented = presentToolItem(tool);
  const input = recordValue(tool.input);
  const read = (...keys: string[]) => keys.map((key) => stringValue(input[key])).find(Boolean) ?? "";
  const legacy = tool.summary?.startsWith(`${tool.name}: `) ? tool.summary.slice(tool.name.length + 2) : tool.summary ?? "";
  let label = presented.verb;
  let detail: string;
  switch (presented.icon) {
    case "file_read":
    case "file_edit":
    case "file_write":
      detail = basename(read("path", "file_path", "filePath") || legacy);
      break;
    case "search":
      detail = read("pattern", "query") || legacy;
      break;
    case "list":
      detail = read("path", "directory", "pattern") || legacy;
      break;
    case "command":
      detail = (read("command", "cmd") || legacy).trim().split("\n")[0];
      break;
    case "web": {
      const url = read("url");
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* A malformed URL still has a readable label. */
      }
      detail = read("query") || host || legacy;
      break;
    }
    case "subagent": {
      const type = stringValue(tool.subagentType) || read("subagent_type");
      detail = type ? `${type} agent` : read("description") || "agent";
      break;
    }
    case "todo":
      detail = "plan";
      break;
    case "mcp":
      detail = presented.title;
      break;
    default:
      // A step the presentation names in its own words ("Generated image",
      // "Waited 10s") says them, as the desktop does; any other names its tool.
      if (presented.title && presented.title !== tool.name) {
        label = presented.title;
        detail = "";
      } else detail = tool.name;
  }
  const live = tool.status === "running";
  const exit = !live && tool.exitCode ? tool.exitCode : 0;
  const failed = !live && (exit !== 0 || presented.tone === "error");
  const end = exit
    ? `exit ${exit}`
    : live
      ? ""
      : tool.status === "error"
        ? "Failed"
        : tool.status === "declined"
          ? "Declined"
          : tool.status === "stopped"
            ? "Stopped"
            : "";
  return { kind: presented.icon, label, detail, end, failed, live };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// Each kind as one clause of a group's summary. The first clause leads with
// its verb ("Read 4 files"); the rest follow quietly ("· 1 search").
const CLAUSES: Record<ConversationToolKind, (count: number) => string> = {
  file_read: (count) => `read ${plural(count, "file", "files")}`,
  file_edit: (count) => `edited ${plural(count, "file", "files")}`,
  file_write: (count) => `wrote ${plural(count, "file", "files")}`,
  search: (count) => plural(count, "search", "searches"),
  list: (count) => `listed ${plural(count, "folder", "folders")}`,
  command: (count) => `ran ${plural(count, "command", "commands")}`,
  web: (count) => `fetched ${plural(count, "page", "pages")}`,
  mcp: (count) => plural(count, "tool call", "tool calls"),
  subagent: (count) => plural(count, "agent", "agents"),
  todo: () => "updated the plan",
  other: (count) => plural(count, "tool call", "tool calls"),
};
/**
 * What a settled group says while it rests collapsed: the kind it is mostly
 * made of (its glyph), "Read 4 files" then "1 search", and how many of its
 * steps went wrong. A failure is the one thing that must not fold away.
 */
export function describeToolGroup(tools: RowTool[]): {
  kind: ConversationToolKind;
  head: string;
  rest: string[];
  failed: number;
} {
  const counts = new Map<ConversationToolKind, number>();
  for (const tool of tools) {
    const kind = presentToolItem(tool).icon;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const [head = "", ...rest] = ranked.map(([kind, count]) => CLAUSES[kind](count));
  return {
    kind: ranked[0]?.[0] ?? "other",
    head: head ? head[0].toUpperCase() + head.slice(1) : "No steps",
    rest,
    failed: tools.filter((tool) => toolStep(tool).failed).length,
  };
}

// ── Turn meta, compaction, plans ───────────────────────────────────────────

/** "Context compacted · automatically · 182k → 24k". */
export function compactionLabel(row: Extract<ConversationRow, { kind: "compaction" }>): string {
  const tokens =
    row.preTokens === undefined
      ? undefined
      : row.postTokens === undefined
        ? `from ${formatTokenCount(row.preTokens)} tokens`
        : `${formatTokenCount(row.preTokens)} → ${formatTokenCount(row.postTokens)}`;
  const trigger = row.beforeCacheExpiry
    ? "automatically, before the cache expired"
    : row.trigger === "auto"
      ? "automatically"
      : row.trigger === "manual"
        ? "on request"
        : undefined;
  return ["Context compacted", trigger, tokens].filter(Boolean).join(" · ");
}

/** "Handed off to a new session · 221k tokens left behind", as the desktop's divider says it. */
export function handoffLabel(row: Extract<ConversationRow, { kind: "handoff" }>): string {
  const left = row.preTokens !== undefined ? `${formatTokenCount(row.preTokens)} tokens left behind` : undefined;
  return ["Handed off to a new session", left].filter(Boolean).join(" · ");
}

/** A model id as a person reads it: the chat's catalog name, else the id without its date suffix. */
export function turnModelLabel(modelId: string | undefined, thread?: ConversationThread): string {
  if (!modelId || modelId === DEFAULT_MODEL_ID) return "";
  return thread?.models?.options.find((option) => option.id === modelId)?.label || modelId.replace(/-\d{8}$/u, "");
}
/** A finished turn's footer before its clock: "Opus 5.5 · 2m 14s". */
export function turnMetaParts(row: Extract<ConversationRow, { kind: "meta" }>, thread?: ConversationThread): string[] {
  return [turnModelLabel(row.modelId, thread), row.durationMs !== undefined ? formatDuration(row.durationMs) : ""].filter(Boolean);
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
/** The plan's own name: its first heading, when it has one. */
export function planTitle(plan: string): string | null {
  for (const line of plan.split(/\r?\n/u)) {
    const match = HEADING.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}
/** The plan under its title: a leading heading is already the card's title. */
export function planBody(plan: string): string {
  const lines = plan.trim().split(/\r?\n/u);
  if (lines[0] && HEADING.test(lines[0])) lines.shift();
  return lines.join("\n").trim();
}

// ── Header and composer ────────────────────────────────────────────────────

/** "Claude Code · Opus 5.5": the chat's CLI and model, where the desktop says. */
export function cliModelLabel(thread: ConversationThread): string {
  const catalog = thread.models;
  const model = turnModelLabel(thread.modelId, thread) || (catalog ? "default model" : "");
  return [catalog?.cliLabel || catalog?.cli, model].filter(Boolean).join(" · ");
}
/** The permission chip's word for a preset: the desktop's own chip-width name. */
export function permissionLabel(preset: ConversationThread["permissionPreset"]): string {
  return PERMISSION_PRESET_OPTIONS.find((option) => option.id === preset)?.chip ?? "No flag";
}
/**
 * The presets the permission sheet offers for a chat: all four where the
 * desktop runs them (cut to the ones the chat's provider lists, else to the
 * ones its CLI's chat runs), Bypass and No flag where it does not, and always
 * the one the chat is on now.
 */
export function permissionChoices(offers: Pick<PhoneChatOffers, "permissionModes">, thread: ConversationThread) {
  return offeredPermissionPresets({
    fourPresets: offers.permissionModes,
    listed: thread.capabilities?.permissionPresets,
    cli: thread.models?.cli?.trim() || cliForChatProvider(thread.providerId),
    current: thread.permissionPreset,
  });
}

/** The CLI's own default model: what `setModel` names to drop a chosen model. */
export const DEFAULT_MODEL_ID = "default";
export type ModelChoice = { id: string; label: string; current: boolean };
/**
 * What the model control shows for a chat: the current model's friendly name,
 * the rows a person can pick (the CLI's default first, then its catalog), and
 * whether picking is offered at all. Null hides the control: the desktop's
 * Studio does not switch models for this pairing (`modelSwitch`: it serves
 * `conversation-models` and the grant reaches the switch), or it listed no
 * catalog for this chat. A chat whose provider cannot switch
 * models mid-conversation shows its model read-only: the desktop refuses a
 * switch for it, started or not, since a listed chat always has a session or
 * a transcript to resume.
 */
export function modelControl(
  offers: Pick<PhoneChatOffers, "modelSwitch">,
  thread: ConversationThread,
): { label: string; choices: ModelChoice[]; editable: boolean } | null {
  const catalog = thread.models;
  if (!catalog || !offers.modelSwitch) return null;
  const current = thread.modelId || DEFAULT_MODEL_ID;
  const choices: ModelChoice[] = [
    { id: DEFAULT_MODEL_ID, label: `${catalog.cliLabel || catalog.cli} default`, current: current === DEFAULT_MODEL_ID },
    ...catalog.options.map((option) => ({
      id: option.id,
      label: option.label || option.id,
      current: option.id === current,
    })),
  ];
  return {
    label: modelLabel(thread),
    choices,
    editable: catalog.liveModelSwitch,
  };
}
/** A model's friendly name: its catalog label, the CLI's name for its default, else the raw id. */
export function modelLabel(thread: ConversationThread): string {
  const catalog = thread.models;
  const id = thread.modelId || DEFAULT_MODEL_ID;
  if (id === DEFAULT_MODEL_ID) return catalog ? `${catalog.cliLabel || catalog.cli} default` : "Default model";
  return catalog?.options.find((option) => option.id === id)?.label || id;
}

/** The longest preview a closed thought shows: one line of it is all that fits. */
const PREVIEW_MAX = 160;
/** How much of a thought the preview reads: its opening, never the whole trace. */
const PREVIEW_READ = 2_048;
/**
 * The line a closed thought previews, as plain words: its first line that is
 * not a fence or a rule, without the marks that make it a heading, a quote or
 * a list item, or bold, code or a link. Only the thought's opening is read,
 * so a trace streaming in one long paragraph costs the same each delta
 * however long it grows.
 */
export function reasoningPreview(text: string): string {
  const head = text.length > PREVIEW_READ ? text.slice(0, PREVIEW_READ) : text;
  let line = "";
  for (let start = 0; start < head.length; ) {
    const end = head.indexOf("\n", start);
    const part = head.slice(start, end === -1 ? head.length : end).trim();
    if (part && !/^(```|~~~|---|\*\*\*)/u.test(part)) {
      line = part;
      break;
    }
    if (end === -1) break;
    start = end + 1;
  }
  const words = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/(\*\*|__|`)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .trim();
  return words.length > PREVIEW_MAX ? `${words.slice(0, PREVIEW_MAX - 1).trimEnd()}\u2026` : words;
}

/**
 * Whether a row is drawn as an agent's reply: Markdown with its diagrams and
 * typeset math. A person's own message never is; it is the text they wrote.
 */
export function drawnAsReply(row: ConversationRow): boolean {
  return row.kind === "message" && row.role === "assistant";
}

/**
 * The turn still arriving, if one is (`replies`' streaming turn); a reply
 * in it, or a fold of its work, is still streaming.
 */
export function streamingTurn(replies: readonly ReplyClock[]): string | null {
  return replies.find((reply) => reply.streaming)?.turn ?? null;
}

/**
 * Whether a reply row may still change: a message of the streaming turn, or
 * one with no turn while a turn is busy (an older desktop's deltas name
 * none), and a fold while its turn is live. Its diagrams and formulas draw
 * only once their blocks are complete while it is (`replyBlockReady`).
 */
export function rowStreaming(row: ConversationRow, turn: string | null, turnBusy: boolean): boolean {
  if (row.kind === "fold" || row.kind === "reasoning") return row.live;
  if (!drawnAsReply(row) || row.kind !== "message") return false;
  return row.turn ? row.turn === turn : turnBusy;
}
