import * as LegacyFileSystem from "expo-file-system/legacy";

import { StudioError, isStudioVersionFailure, presentStudioFailure, type StudioClient } from "../../../packages/client-runtime/src/public";
import type {
  ConversationCommand,
  ConversationListedThread,
  ConversationQueuedFrame,
  ConversationScheduledFrame,
  ConversationSubagentsFrame,
  ConversationUsageLimitsFrame,
  ConversationWireEvent,
  ConversationWireKey,
  ConversationWirePage,
  ConversationWirePermissionPreset,
} from "../../../packages/conversation-protocol/src/public";
import {
  STUDIO_COMMAND_METHODS,
  type StudioCommandMethod,
  type StudioMethod,
} from "../../../packages/studio-protocol/src/public";
import {
  conversationSendProblem,
  conversationSessionWasLost,
  heldSendLanded,
} from "../features/conversations/sendRules";
import { queuedSendStale, turnEndedSince } from "../features/conversations/queuedSends";
import {
  DESKTOP_STUDIO_OUTDATED,
  desktopStudio,
  watchDesktopStudio,
  type DesktopStudioOptions,
  type DesktopTarget,
} from "./desktopStudio";

// The phone's chats on a paired desktop, over the desktop's Studio protocol:
// the one connection per desktop the shared client runtime keeps
// (`desktopStudio.ts`), a chat followed as every client follows one (topic
// `conversation.session`, resumed by its cursor across a dropped connection,
// no event missed or repeated), the chat's watches as push topics, and every
// command a method of the protocol under the phone's own command id, which
// the client sends again after a reconnect and the desktop answers once.
//
// What is the phone's own is kept here: the sends it holds until a turn
// ends, hands to the desktop to hold, or no longer sends without asking
// after an absence (`queuedSends.ts`), and the reads a chat's screens make.
// There is no socket, no frame parser and no reconnect loop of its own.

export type ConversationThread = ConversationListedThread;
type Send = Extract<ConversationCommand, { kind: "send" }>;

/**
 * `blocked`: the device may no longer read this conversation (its grant lost
 * `conversation:read`), so the stream stopped. `revoked`: the desktop revoked
 * this phone; only pairing again helps. Neither retries. `unavailable`: the
 * desktop refused the subscription and said retrying will not help (the
 * conversation is gone, say), or it is too old to speak the protocol; the
 * stream waits for `retry()`.
 */
export type ConversationConnectionState =
  | "connecting"
  | "synchronizing"
  | "live"
  | "offline"
  | "unavailable"
  | "blocked"
  | "revoked";

/** How a command ended, as the desktop answered its method. */
export type ConversationCommandAnswer =
  | {
      type: "commandResult";
      commandId: string;
      ok: true;
      notice?: string;
      modelId?: string;
      permissionPreset?: ConversationWirePermissionPreset;
      permissionMode?: string;
    }
  | { type: "commandResult"; commandId: string; ok: false; code?: string; message: string; retryAfterMs?: number };

/** What a chat's stream hands its screen: the chat as it is followed, its watches, and each command's answer. */
export type ConversationStreamFrame =
  | { type: "snapshot"; page: ConversationWirePage; reset?: true; generation?: string }
  | { type: "event"; event: ConversationWireEvent }
  | { type: "synchronized"; seq: number; generation?: string }
  | ConversationQueuedFrame
  | ConversationScheduledFrame
  | ConversationSubagentsFrame
  | ConversationUsageLimitsFrame
  | ConversationCommandAnswer;

/** What a chat's screens read of it beside its stream, each a method of the protocol. */
export type ChatRead =
  | { type: "loadEarlier"; beforeCursor: number; turnLimit?: number }
  | { type: "getToolDetail"; toolUseId: string }
  | { type: "getTurnDiff"; turnSeq: number; path?: string }
  | { type: "getEvent"; seq: number; id: string };

export interface ConversationStreamHandlers {
  onState(state: ConversationConnectionState, detail?: string): void;
  onFrame(frame: ConversationStreamFrame): void;
  onSendStarted?(commandId: string): void;
  /**
   * The desktop turned a send away because a turn is running there: it stays
   * here under its id and goes when the turn ends.
   */
  onSendWaiting?(commandId: string): void;
  /**
   * A send the desktop turned away busy was offered to it again, under the
   * same id, to hold until the turn ends (`conversation-queued-sends`):
   * `command` is the send as it is now offered, and `heldAfter` the cursor
   * no offer of it precedes, for the cache to keep.
   */
  onSendHeld?(commandId: string, command: Send, heldAfter: number): void;
  /**
   * A send this stream no longer offers without asking: it waited across an
   * absence too long, or its turn ended meanwhile, or the desktop refused it
   * `stale`. It waits for the person's Send now (the same command with
   * `confirmedStale`, under its id) or Discard (`cancelPending`).
   */
  onSendStale?(commandId: string): void;
}

export interface ConversationStream {
  command(command: ConversationCommand, commandId?: string): string;
  /** Stop offering a send: one waiting here, one not yet offered to be held, or one no longer sent without asking. */
  cancelPending(commandId: string): void;
  /** One read of the chat, answered as its method answers with `ok: true` beside it, or refused in the desktop's words. */
  read(input: ChatRead): Promise<Record<string, unknown>>;
  /** The app came back to the front after `backgroundMs` away. */
  foreground(backgroundMs: number): void;
  /** Follow again now, after the desktop refused the subscription outright. */
  retry(): void;
  close(): void;
}

/** A send carried over from the cache, which waited while no stream offered it. */
export type CarriedSend = {
  commandId: string;
  command: Send;
  /** A held send's cursor when it was queued (`CachedConversation`). */
  heldAfter?: number;
  /** When it was written (`CachedConversation`). */
  queuedAt?: number;
  /** Already no longer sent without asking. */
  stale?: true;
};

/** Which picture of a chat: the step that made or read it, or the `ref` a message recorded. */
export type ConversationImageRef = { workspaceId: string; agentId: string } & (
  | { toolUseId: string; attachment?: never }
  | { attachment: string; toolUseId?: never }
);

/**
 * Why a picture did not load, as a person needs it: `gone` (the desktop no
 * longer has it, or the chat), `too_large`, or `unavailable` for anything else.
 */
export type ConversationImageProblem = "gone" | "too_large" | "unavailable";

/** A chat's picture as a file on the phone, or why there is none. */
export type ConversationPicture = { ok: true; uri: string } | { ok: false; problem: ConversationImageProblem };

export interface ConversationApi {
  list(): Promise<ConversationThread[]>;
  open(
    key: ConversationWireKey,
    afterSeq: number,
    handlers: ConversationStreamHandlers,
    options?: {
      /**
       * Sends carried over from the cache: each is offered only while
       * `queuedSendStale` allows, and is otherwise handed back through
       * `onSendStale`.
       */
      pendingSends?: CarriedSend[];
      initiallyBusy?: boolean;
      /**
       * The log generation `afterSeq` belongs to, from a cached snapshot or
       * fence. With it the desktop sends only the missed events; without it,
       * or when the log has moved on, it sends a snapshot.
       */
      generation?: string;
    },
  ): ConversationStream;
  /** A picture for the chat's next message, staged on the desktop: the send names the id this answers. */
  uploadImage(input: { uri: string; name: string; mediaType: string }): Promise<string>;
  /** A file of any type for the chat's next message (`conversation-message-files`, up to 25 MB). */
  uploadFile(input: { uri: string; name: string; mediaType: string }): Promise<string>;
  /**
   * One of a chat's pictures as a file in the phone's cache, read once from
   * the desktop (`conversation.picture`) and from the cache after that: a
   * step's picture and a sent one never change.
   */
  picture(ref: ConversationImageRef): Promise<ConversationPicture>;
}

const TURN_ENDS = ["turn_completed", "turn_failed", "session_stopped", "session_closed"];
/** The first page a chat opens on, and each earlier one. */
const TURN_LIMIT = 10;
/** A desktop that could not be reached is tried again from a second, doubling to half a minute. */
const ATTACH_RETRY_MS = { first: 1_000, most: 30_000 };
const BUSY_RETRY_MS = 1_000;
/** Away for this long, the app back in front asks the connection whether it is still there. */
const FOREGROUND_WAKE_MS = 10_000;

/** The method each command kind is carried by. */
const COMMAND_METHOD = Object.fromEntries(
  Object.entries(STUDIO_COMMAND_METHODS).map(([method, kind]) => [kind, method]),
) as Record<ConversationCommand["kind"], StudioCommandMethod | undefined>;

function identifier(): string {
  return globalThis.crypto?.randomUUID?.() ?? `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** A refusal's code and words, whatever threw it. */
function refusalOf(error: unknown): { code?: string; message: string; retryAfterMs?: number } {
  if (error instanceof StudioError)
    return {
      code: error.code,
      message: error.message,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  return { message: error instanceof Error && error.message ? error.message : "The desktop could not answer." };
}

/** Refused because the connection that carried it is gone for good: the request never reached an answer. */
const unanswered = (code: string | undefined) => code === "closed" || code === "environment_changed";

export function createDesktopConversationsApi(
  target: DesktopTarget,
  input: DesktopStudioOptions & { /** The wall clock a waiting send's age is read against. */ now?: () => number } = {},
): ConversationApi {
  const now = input.now ?? Date.now;
  const studio = () => desktopStudio(target, input);
  return {
    list: async () => (await (await studio()).request("conversation.list", {})).conversations,
    open: (key, afterSeq, handlers, options) => openStream({ key, afterSeq, handlers, options, studio, now, target }),
    uploadImage: async (file) => upload(await studio(), file, "picture"),
    uploadFile: async (file) => upload(await studio(), file, "attachment"),
    picture: (ref) => picture(target, studio, ref),
  };
}

function openStream(input: {
  key: ConversationWireKey;
  afterSeq: number;
  handlers: ConversationStreamHandlers;
  options: Parameters<ConversationApi["open"]>[3];
  studio: () => Promise<StudioClient>;
  now: () => number;
  target: DesktopTarget;
}): ConversationStream {
  const { key, handlers, options, now } = input;
  const ref = { workspaceId: key.workspaceId, agentId: key.agentId };
  let closed = false;
  let afterSeq = input.afterSeq;
  let logGeneration = options?.generation;
  let client: StudioClient | null = null;
  // Each client this stream has used, so a command offered on one that has
  // since closed for good is offered again on the next.
  let clientGeneration = 0;
  let attachAttempt = 0;
  let attachTimer: ReturnType<typeof setTimeout> | null = null;
  let followStop: (() => void) | null = null;
  const pushStops: Array<() => void> = [];
  let unwatch: (() => void) | null = null;
  let sendRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let heldRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // What this stream may hand the desktop to hold, read from its welcome.
  const serves = (capability: string) => client?.welcome.conversation.capabilities.includes(capability) === true;
  const holdable = (command: Send) =>
    serves("conversation-queued-sends") &&
    (!command.uploadIds?.length || serves("conversation-queued-attachments"));

  // Sends this phone holds until the turn ends, in the order written.
  const outbox = new Map<string, Send>();
  // Sends handed to the desktop to hold (`queue`), until it answers. They go
  // at once, turn or no turn. `sentAfter` is a cursor no offer of it
  // precedes (`heldSendLanded`): where this stream first offered it, or, for
  // one taken over from the cache, where it was queued. `client` is the
  // client it was offered on, so a new one offers it again.
  const held = new Map<string, { command: Send; sentAfter: number | null; client: number }>();
  // Sends no longer offered without asking (`onSendStale`), until the person
  // sends one again or lets it go.
  const parked = new Map<string, { command: Send; sentAfter: number | null }>();
  // When each waiting send was written, and which of them waited while this
  // phone was away: those are offered only while `queuedSendStale` allows and
  // their turn has not ended meanwhile.
  const written = new Map<string, number | undefined>();
  const away = new Set<string>();
  // Sends already offered again to be held after a busy refusal: once.
  const reheld = new Set<string>();
  // Steers: offered the moment they are made, beside the running turn, never
  // behind it. `client` is the client it was last offered on.
  const steering = new Map<string, { command: Send; client: number }>();
  // Sends already offered a second time after the desktop lost the session
  // they went to: once, never twice.
  const resentAfterLostSession = new Set<string>();
  let synchronized = false;
  let busy = options?.initiallyBusy ?? false;
  let activeSendId: string | null = null;

  const take = (commandId: string, command: Send, sentAfter: number | null = null, queuedAt = command.composedAt) => {
    parked.delete(commandId);
    written.set(commandId, queuedAt);
    if (command.queue && holdable(command)) held.set(commandId, { command, sentAfter, client: -1 });
    else if (command.steer === true) steering.set(commandId, { command, client: -1 });
    else {
      const { queue: _queue, ...plain } = command;
      outbox.set(commandId, plain);
    }
  };
  // Taken over from the cache: what waited too long, or was found stale
  // before, is never offered; the rest is offered once the replay has said
  // whether its turn ended meanwhile. Whether one queued to be held can be
  // held is read once the desktop has said what it serves.
  const staleAtOpen: string[] = [];
  const carried: CarriedSend[] = [];
  for (const item of options?.pendingSends ?? []) {
    const queuedAt = item.queuedAt ?? item.command.composedAt;
    if (queuedSendStale({ queuedAt, stale: item.stale, command: item.command }, now())) {
      written.set(item.commandId, queuedAt);
      parked.set(item.commandId, {
        command: item.command,
        sentAfter: item.command.queue ? (item.heldAfter ?? input.afterSeq) : null,
      });
      staleAtOpen.push(item.commandId);
      continue;
    }
    carried.push(item);
  }

  const park = (commandId: string): boolean => {
    const plain = outbox.get(commandId);
    const handed = held.get(commandId);
    const command = plain ?? handed?.command ?? steering.get(commandId)?.command;
    if (!command) return false;
    outbox.delete(commandId);
    held.delete(commandId);
    steering.delete(commandId);
    away.delete(commandId);
    parked.set(commandId, { command, sentAfter: handed?.sentAfter ?? null });
    if (activeSendId === commandId) activeSendId = null;
    handlers.onSendStale?.(commandId);
    return true;
  };
  const staleAfterAbsence = (commandId: string, endedAt?: number) => {
    if (!away.has(commandId)) return false;
    const command = outbox.get(commandId) ?? held.get(commandId)?.command ?? steering.get(commandId)?.command;
    if (!command || command.confirmedStale === true) return false;
    const queuedAt = written.get(commandId);
    return queuedSendStale({ queuedAt, command }, now()) || (endedAt !== undefined && turnEndedSince({ queuedAt }, endedAt));
  };
  // Events before the fence are what happened while this phone was not
  // listening: a turn that ended among them was one a carried send waited on.
  const parkAfterReplayedEnds = (events: readonly ConversationWireEvent[]) => {
    if (synchronized || !away.size) return;
    for (const event of events) {
      if (!TURN_ENDS.includes(event.type)) continue;
      for (const commandId of [...away]) if (staleAfterAbsence(commandId, event.createdAt)) park(commandId);
    }
  };

  /** One command as its method, answered into `answered`. */
  const offer = (commandId: string, command: ConversationCommand): boolean => {
    const method = COMMAND_METHOD[command.kind];
    if (!client || closed) return false;
    const { kind: _kind, ...members } = command;
    const using = clientGeneration;
    if (!method) {
      answered(commandId, { ok: false, code: "unsupported_command", message: "This desktop does not take that." }, using);
      return true;
    }
    client
      .request(method as StudioMethod, { key: ref, commandId, ...members } as never)
      .then(
        (result) => answered(commandId, { ok: true, ...(result as object) }, using),
        (error: unknown) => answered(commandId, { ok: false, ...refusalOf(error) }, using),
      );
    return true;
  };

  const flushSend = () => {
    if (!synchronized || busy || activeSendId || sendRetryTimer || !client) return;
    for (const [commandId, command] of outbox) {
      const problem = conversationSendProblem(commandId, command);
      if (problem) {
        outbox.delete(commandId);
        handlers.onFrame({ type: "commandResult", commandId, ok: false, code: "too_large", message: problem });
        continue;
      }
      activeSendId = commandId;
      offer(commandId, command);
      handlers.onSendStarted?.(commandId);
      return;
    }
  };
  const flushHeld = () => {
    if (!synchronized || heldRetryTimer || !client) return;
    for (const [commandId, entry] of held) {
      if (entry.client === clientGeneration) continue;
      const problem = conversationSendProblem(commandId, entry.command);
      if (problem) {
        held.delete(commandId);
        handlers.onFrame({ type: "commandResult", commandId, ok: false, code: "too_large", message: problem });
        continue;
      }
      if (!offer(commandId, entry.command)) return;
      entry.sentAfter ??= afterSeq;
      entry.client = clientGeneration;
    }
  };
  const flushSteer = () => {
    if (!synchronized || !client) return;
    for (const [commandId, entry] of steering) {
      if (entry.client === clientGeneration) continue;
      if (!offer(commandId, entry.command)) return;
      entry.client = clientGeneration;
      handlers.onSendStarted?.(commandId);
    }
  };
  // Hands a line of sends waiting here to a desktop that holds messages, in
  // the order they were written, to send when the chat's turn ends whether or
  // not this phone is still there. All of them or none, so a held one cannot
  // overtake one the phone still has. Each is offered again under its own id, once.
  const handOver = (line: [string, Send][]): boolean => {
    if (!line.length || !line.every(([commandId, command]) => !command.steer && holdable(command) && !reheld.has(commandId)))
      return false;
    for (const [commandId, command] of line) {
      reheld.add(commandId);
      outbox.delete(commandId);
      const { uploadIds, ...words } = command;
      const heldCommand = { ...words, ...(uploadIds?.length ? { uploadIds } : {}), queue: true as const };
      held.set(commandId, { command: heldCommand, sentAfter: null, client: -1 });
      handlers.onSendHeld?.(commandId, heldCommand, afterSeq);
    }
    if (activeSendId && !outbox.has(activeSendId)) activeSendId = null;
    flushHeld();
    return true;
  };
  const waitingBehind = (): [string, Send][] => {
    if (activeSendId !== null && outbox.has(activeSendId)) return [];
    return busy || activeSendId !== null ? [...outbox] : [];
  };
  // A held send carried across a closed app, found already in the chat: it
  // is settled as accepted and never offered again. Only the first person's
  // message after the offer can be it (`heldSendLanded`).
  const settleLandedHeld = (events: readonly ConversationWireEvent[]) => {
    const landed: string[] = [];
    for (const event of events) {
      if (event.type !== "user_message" || event.seq === undefined) continue;
      for (const waiting of [held, parked]) {
        for (const [commandId, entry] of waiting) {
          if (!entry.command.queue || entry.sentAfter === null || event.seq <= entry.sentAfter) continue;
          if (heldSendLanded(event, entry.command.message, entry.sentAfter)) {
            waiting.delete(commandId);
            landed.push(commandId);
          } else entry.sentAfter = Number.MAX_SAFE_INTEGER;
        }
      }
    }
    return landed;
  };
  const tookMessage = (commandId: unknown) => {
    if (typeof commandId !== "string") return;
    outbox.delete(commandId);
    parked.delete(commandId);
    steering.delete(commandId);
  };

  /** A command's answer: the stream's own sends settled here first, then handed on. */
  function answered(
    commandId: string,
    answer: { ok: true } & Record<string, unknown> | { ok: false; code?: string; message: string; retryAfterMs?: number },
    using: number,
  ) {
    if (closed) return;
    // Its client closed for good before an answer: offered again on the next.
    if (!answer.ok && unanswered(answer.code)) {
      const entry = held.get(commandId) ?? steering.get(commandId);
      if (entry && entry.client === using) entry.client = -1;
      if (activeSendId === commandId) activeSendId = null;
      if (outbox.has(commandId) || entry) return;
    }
    const frame = { type: "commandResult" as const, commandId, ...answer } as ConversationCommandAnswer;
    if (!answer.ok && answer.code === "stale" && (outbox.has(commandId) || held.has(commandId) || steering.has(commandId))) {
      park(commandId);
      flushSend();
      return;
    }
    if (steering.has(commandId)) {
      const entry = steering.get(commandId)!;
      if (!answer.ok && answer.code === "busy") {
        // Neither taken into the turn nor held there: handed over to be held
        // where the desktop holds messages, else kept here for the turn's end.
        steering.delete(commandId);
        const { steer: _steer, ...plain } = entry.command;
        if (handOver([[commandId, plain]])) return;
        outbox.set(commandId, entry.command);
        handlers.onSendWaiting?.(commandId);
        flushSend();
        return;
      }
      if (conversationSessionWasLost({ ok: answer.ok, ...(answer.ok ? {} : answer) }) && !resentAfterLostSession.has(commandId)) {
        resentAfterLostSession.add(commandId);
        entry.client = -1;
        flushSteer();
        return;
      }
      steering.delete(commandId);
    }
    if (held.has(commandId)) {
      if (!answer.ok && answer.code === "busy") {
        held.get(commandId)!.client = -1;
        if (heldRetryTimer) clearTimeout(heldRetryTimer);
        heldRetryTimer = setTimeout(() => {
          heldRetryTimer = null;
          flushHeld();
        }, answer.retryAfterMs ?? BUSY_RETRY_MS);
        return;
      }
      held.delete(commandId);
    }
    if (outbox.has(commandId) && !answer.ok && answer.code === "busy") {
      // A turn is running there that this phone had not heard of: the line
      // goes to a desktop that holds messages, from its oldest send, or waits
      // here and is offered again after the delay the desktop asked for.
      const line = [...outbox];
      if (line[0]?.[0] === commandId && handOver(line)) return;
      handlers.onSendWaiting?.(commandId);
      if (activeSendId === commandId) activeSendId = null;
      if (sendRetryTimer) clearTimeout(sendRetryTimer);
      sendRetryTimer = setTimeout(() => {
        sendRetryTimer = null;
        flushSend();
      }, answer.retryAfterMs ?? BUSY_RETRY_MS);
      return;
    }
    if (outbox.has(commandId) && conversationSessionWasLost({ ok: answer.ok, ...(answer.ok ? {} : answer) }) && !resentAfterLostSession.has(commandId)) {
      // The server running the chat restarted after the desktop found its
      // session: offered once more under the same id, it resumes the chat.
      resentAfterLostSession.add(commandId);
      if (activeSendId === commandId) activeSendId = null;
      flushSend();
      return;
    }
    if (outbox.has(commandId)) {
      outbox.delete(commandId);
      if (activeSendId === commandId && (!answer.ok || !busy)) {
        activeSendId = null;
        flushSend();
      } else if (synchronized) handOver(waitingBehind());
    }
    handlers.onFrame(frame);
  }

  /** One frame of the followed chat. */
  function followed(frame: { type: "snapshot"; page: ConversationWirePage; reset?: true; generation?: string } | { type: "event"; event: ConversationWireEvent } | { type: "synchronized"; seq: number; generation?: string }) {
    if (closed) return;
    let shown = frame;
    if (frame.type === "snapshot") {
      // A snapshot from another log generation replaces everything held,
      // whatever its reset flag says.
      const replaces = frame.reset === true || (logGeneration !== undefined && frame.generation !== logGeneration);
      shown = replaces ? { ...frame, reset: true } : frame;
      if (replaces) {
        logGeneration = frame.generation;
        afterSeq = frame.page.events.reduce((last, event) => Math.max(last, event.seq ?? 0), 0);
        busy = false;
        for (const event of frame.page.events) {
          if (event.type === "user_message" || event.type === "turn_started") busy = true;
          if (TURN_ENDS.includes(event.type)) busy = false;
        }
      }
    }
    let landed: string[] = [];
    if (frame.type === "snapshot") {
      landed = settleLandedHeld(frame.page.events);
      for (const event of frame.page.events) if (event.type === "user_message") tookMessage(event.payload?.commandId);
      if (activeSendId && !outbox.has(activeSendId) && !busy) activeSendId = null;
    }
    if (frame.type === "event") {
      landed = settleLandedHeld([frame.event]);
      afterSeq = Math.max(afterSeq, frame.event.seq ?? 0);
      if (frame.event.type === "user_message") {
        busy = true;
        tookMessage(frame.event.payload?.commandId);
        if (synchronized) handOver(waitingBehind());
      }
      if (frame.event.type === "turn_started") busy = true;
      if (TURN_ENDS.includes(frame.event.type)) {
        busy = false;
        activeSendId = null;
        flushSend();
      }
    }
    if (frame.type === "snapshot") parkAfterReplayedEnds(frame.page.events);
    if (frame.type === "event") parkAfterReplayedEnds([frame.event]);
    handlers.onFrame(shown);
    if (frame.type === "synchronized") {
      afterSeq = frame.seq;
      if (frame.generation !== undefined) logGeneration = frame.generation;
      for (const commandId of [...away]) if (staleAfterAbsence(commandId)) park(commandId);
      away.clear();
      synchronized = true;
      attachAttempt = 0;
      handlers.onState("live");
      handOver(waitingBehind());
      flushSend();
      flushHeld();
      flushSteer();
    }
    for (const commandId of landed) handlers.onFrame({ type: "commandResult", commandId, ok: true });
  }

  const stop = (state: Extract<ConversationConnectionState, "blocked" | "revoked" | "unavailable">, detail: string) => {
    if (state !== "unavailable") closed = true;
    detach();
    handlers.onState(state, detail);
  };
  const detach = () => {
    synchronized = false;
    activeSendId = null;
    followStop?.();
    followStop = null;
    for (const stopPush of pushStops.splice(0)) stopPush();
    unwatch?.();
    unwatch = null;
    if (attachTimer) clearTimeout(attachTimer);
    attachTimer = null;
    if (sendRetryTimer) clearTimeout(sendRetryTimer);
    sendRetryTimer = null;
    if (heldRetryTimer) clearTimeout(heldRetryTimer);
    heldRetryTimer = null;
    client = null;
  };
  /** Why the connection or the follow ended, as the stream's state. */
  const ended = (error: unknown) => {
    if (closed) return;
    const { code, message } = refusalOf(error);
    if (code === "unauthorized" || code === "revoked") return stop("revoked", "This phone is no longer paired with the desktop.");
    if (code === "peer_mismatch") return stop("blocked", message);
    if (code === "scope_required") return stop("blocked", "This device no longer has access to this conversation.");
    // A version mismatch is final until one side updates: said, with which
    // side, and not tried again.
    const failure = presentStudioFailure(error);
    if (isStudioVersionFailure(failure.kind))
      return stop("unavailable", code === "unsupported_protocol_version" ? failure.message : DESKTOP_STUDIO_OUTDATED);
    if (code === "not_found") return stop("unavailable", message);
    // Anything else may pass: the desktop asleep, the network gone, a
    // connection closed for good. Tried again, from a second up to half a minute.
    detach();
    handlers.onState("offline", message);
    const wait = Math.min(ATTACH_RETRY_MS.most, ATTACH_RETRY_MS.first * 2 ** attachAttempt++);
    attachTimer = setTimeout(() => {
      attachTimer = null;
      void attach();
    }, wait);
  };

  async function attach() {
    if (closed || client) return;
    handlers.onState("connecting");
    let reached: StudioClient;
    try {
      reached = await input.studio();
    } catch (error) {
      ended(error);
      return;
    }
    if (closed || client) return;
    client = reached;
    clientGeneration++;
    // Taken over now the desktop has said whether it holds messages.
    for (const item of carried.splice(0)) {
      take(item.commandId, item.command, item.heldAfter ?? input.afterSeq, item.queuedAt ?? item.command.composedAt);
      away.add(item.commandId);
    }
    handlers.onState("synchronizing");
    unwatch = watchDesktopStudio(input.target, (state, error) => {
      if (closed || client !== reached) return;
      if (state === "open") {
        if (!synchronized) handlers.onState("synchronizing");
        return;
      }
      synchronized = false;
      if (state === "closed" || (state === "parked" && error && error.code !== "offline")) ended(error ?? new StudioError("closed", "The desktop closed the connection."));
      else handlers.onState("offline", error?.message);
    });
    // The chat, from its cursor, resumed by the client across every drop.
    const events = reached.conversations.events(ref, {
      ...(logGeneration !== undefined && afterSeq > 0 ? { cursor: { afterSeq, generation: logGeneration } } : {}),
      turnLimit: TURN_LIMIT,
    });
    followStop = () => events.close();
    void (async () => {
      try {
        for await (const frame of events) followed(frame);
        if (client === reached) ended(new StudioError("closed", "The desktop ended the conversation's stream."));
      } catch (error) {
        if (client === reached) ended(error);
      }
    })();
    // The chat's watches, told what stands on subscribing and again on each
    // change, and subscribed again by the client on every connection.
    const watch = <T extends { key: ConversationWireKey }>(topic: string, capability: string) => {
      if (!reached.welcome.conversation.capabilities.includes(capability)) return;
      pushStops.push(
        reached.subscribe(topic as never, { key: ref } as never, {
          onPayload: (payload) => {
            const frame = payload as unknown as T;
            if (closed || frame.key.workspaceId !== key.workspaceId || frame.key.agentId !== key.agentId) return;
            handlers.onFrame(frame as unknown as ConversationStreamFrame);
          },
        }),
      );
    };
    watch<ConversationQueuedFrame>("conversation.queued", "conversation-queued-sends");
    watch<ConversationScheduledFrame>("conversation.scheduled", "conversation-scheduled-sends");
    watch<ConversationSubagentsFrame>("conversation.subagents", "conversation-subagents");
    watch<ConversationUsageLimitsFrame>("conversation.usageLimits", "conversation-usage-limits");
  }

  void attach();
  if (staleAtOpen.length)
    void Promise.resolve().then(() => {
      for (const commandId of staleAtOpen) if (!closed && parked.has(commandId)) handlers.onSendStale?.(commandId);
    });

  return {
    command(command, suppliedId) {
      const commandId = suppliedId ?? identifier();
      if (command.kind === "send") {
        const problem = conversationSendProblem(commandId, command);
        if (problem) throw new Error(problem);
        take(commandId, command);
        // Made while the chat is busy here: handed to a desktop that holds
        // messages at once, so it goes when the turn ends whether or not this
        // phone is awake then.
        if (outbox.has(commandId)) handOver(waitingBehind());
        flushSend();
        flushHeld();
        flushSteer();
      } else if (!synchronized || !offer(commandId, command)) throw new Error("Reconnect before using this action.");
      return commandId;
    },
    cancelPending(commandId) {
      parked.delete(commandId);
      away.delete(commandId);
      carried.splice(0, carried.length, ...carried.filter((item) => item.commandId !== commandId));
      if (activeSendId !== commandId) outbox.delete(commandId);
      // One already offered is the desktop's to give back (`cancelQueued`).
      if (held.get(commandId)?.sentAfter === null) held.delete(commandId);
      if (steering.get(commandId)?.client === -1) steering.delete(commandId);
    },
    async read(request) {
      if (!client || !synchronized) throw new Error("Reconnect before requesting conversation details.");
      const reading = client;
      const answer = async (): Promise<unknown> => {
        switch (request.type) {
          case "loadEarlier":
            return reading.request("conversation.loadEarlier", {
              key: ref,
              beforeCursor: request.beforeCursor,
              turnLimit: request.turnLimit ?? TURN_LIMIT,
            });
          case "getToolDetail":
            return reading.request("conversation.toolDetail", { key: ref, toolUseId: request.toolUseId });
          case "getTurnDiff":
            return reading.request("conversation.turnDiff", {
              key: ref,
              turnSeq: request.turnSeq,
              ...(request.path === undefined ? {} : { path: request.path }),
            });
          case "getEvent":
            return reading.request("conversation.event", { key: ref, seq: request.seq, id: request.id });
        }
      };
      return { ok: true, ...((await answer()) as object) };
    },
    foreground(backgroundMs) {
      if (closed) return;
      // What waited while the app was away is offered only if it is still
      // young and its turn did not end meanwhile: the resume's replay says which.
      if (backgroundMs >= FOREGROUND_WAKE_MS)
        for (const commandId of [...outbox.keys(), ...held.keys(), ...steering.keys()]) away.add(commandId);
      if (client) {
        // Pings a connection that may have been left half-open, and makes it
        // again if nothing answers; the follow resumes from its cursor.
        client.wake();
        return;
      }
      // Back in front is a fresh start, not the half-minute that failures
      // while the phone was away built up.
      attachAttempt = 0;
      if (attachTimer) clearTimeout(attachTimer);
      attachTimer = null;
      void attach();
    },
    retry() {
      if (closed) return;
      detach();
      attachAttempt = 0;
      void attach();
    },
    close() {
      closed = true;
      detach();
    },
  };
}

// ── Uploads ─────────────────────────────────────────────────────────────────

/**
 * A file on the phone staged on the desktop for a send: begun with its size,
 * then sent in the pieces the desktop names (`uploads.append`), each read
 * from the file as it goes, so no more than one piece is ever held. The
 * client sends a piece again after a dropped connection, and the desktop
 * takes a repeat once. Answers the id a send names it by.
 */
async function upload(
  client: StudioClient,
  file: { uri: string; name: string; mediaType: string },
  purpose: "picture" | "attachment",
): Promise<string> {
  const what = purpose === "picture" ? "picture" : "file";
  const info = await LegacyFileSystem.getInfoAsync(file.uri);
  if (!info.exists || typeof info.size !== "number" || info.size <= 0) throw new Error(`The ${what} could not be read.`);
  const byteLength = info.size;
  try {
    const { uploadId, chunkBytes } = await client.request("uploads.begin", {
      mediaType: file.mediaType,
      byteLength,
      name: file.name,
      purpose,
    });
    for (let offset = 0; offset < byteLength; offset += chunkBytes) {
      const dataBase64 = await LegacyFileSystem.readAsStringAsync(file.uri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
        position: offset,
        length: Math.min(chunkBytes, byteLength - offset),
      });
      await client.request("uploads.append", { uploadId, offset, dataBase64 });
    }
    return uploadId;
  } catch (error) {
    const { code, message } = refusalOf(error);
    if (code === "too_large")
      throw new Error(purpose === "picture" ? "The picture is over the desktop's size limit." : message);
    throw new Error(message || `The desktop refused the ${what} upload.`);
  }
}

// ── Pictures ────────────────────────────────────────────────────────────────

const PICTURE_FOLDER = "chat-pictures/";
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
/** Pictures being read now, by their file: one read however many rows draw it. */
const reading = new Map<string, Promise<ConversationPicture>>();

/**
 * How many pictures cross from the desktops at once. One answer can be 8 MB,
 * about 11 MB of text held twice while it is read; a transcript scrolled past
 * a run of screenshots would otherwise hold every one of them at once, and
 * keep the chat's own frames waiting behind them on the socket.
 */
const PICTURES_AT_ONCE = 2;
let picturesCrossing = 0;
const picturesWaiting: Array<() => void> = [];

/** Run `work` once a crossing is free; a finished one hands its turn straight to the next. */
async function crossingOne<T>(work: () => Promise<T>): Promise<T> {
  if (picturesCrossing < PICTURES_AT_ONCE) picturesCrossing++;
  else await new Promise<void>((resolve) => picturesWaiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = picturesWaiting.shift();
    if (next) next();
    else picturesCrossing--;
  }
}

/** A short stable name for a picture's address: FNV-1a over its parts, twice over. */
function pictureName(parts: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < parts.length; index++) {
    const code = parts.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * A chat's picture as a file in the phone's cache. Its bytes cross once, as
 * one answer, and go straight to the file; the transcript draws the file, so
 * the picture is decoded by the platform and never held as text after that.
 * The cache is the system's to empty when it needs the room.
 */
async function picture(
  target: DesktopTarget,
  studio: () => Promise<StudioClient>,
  ref: ConversationImageRef,
): Promise<ConversationPicture> {
  const base = LegacyFileSystem.cacheDirectory;
  if (!base) return { ok: false, problem: "unavailable" };
  const which = ref.toolUseId !== undefined ? `step\n${ref.toolUseId}` : `sent\n${ref.attachment}`;
  const stem = `${base}${PICTURE_FOLDER}${pictureName(`${target.baseUrl}\n${ref.workspaceId}\n${ref.agentId}\n${which}`)}`;
  const known = reading.get(stem);
  if (known) return known;
  const read = (async (): Promise<ConversationPicture> => {
    for (const extension of Object.values(EXTENSIONS)) {
      const info = await LegacyFileSystem.getInfoAsync(`${stem}.${extension}`).catch(() => null);
      if (info?.exists) return { ok: true, uri: `${stem}.${extension}` };
    }
    try {
      const client = await studio();
      // The text is let go once it is in the file, before the next crossing starts.
      const path = await crossingOne(async () => {
        const answer = await client.request("conversation.picture", {
          key: { workspaceId: ref.workspaceId, agentId: ref.agentId },
          ...(ref.toolUseId !== undefined ? { toolUseId: ref.toolUseId } : { attachment: ref.attachment! }),
        });
        const file = `${stem}.${EXTENSIONS[answer.mediaType] ?? "img"}`;
        await LegacyFileSystem.makeDirectoryAsync(`${base}${PICTURE_FOLDER}`, { intermediates: true }).catch(() => undefined);
        await LegacyFileSystem.writeAsStringAsync(file, answer.dataBase64, { encoding: LegacyFileSystem.EncodingType.Base64 });
        return file;
      });
      return { ok: true, uri: path };
    } catch (error) {
      const { code } = refusalOf(error);
      return { ok: false, problem: code === "not_found" ? "gone" : code === "too_large" ? "too_large" : "unavailable" };
    }
  })();
  reading.set(stem, read);
  void read.finally(() => {
    if (reading.get(stem) === read) reading.delete(stem);
  });
  return read;
}
