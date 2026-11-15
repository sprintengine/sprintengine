import type { StudioClient } from "../../../packages/client-runtime/src/public";
import { desktopStudio, studioFailure, type DesktopStudioOptions } from "./desktopStudio";
import type { ApiResult } from "./types";

// A chat's rest, visit clock and marks on its desktop, from the phone: the
// desktop's `conversation.settle`, `.visit`, `.markUnread` and `.snooze` on its
// Studio protocol (desktopStudio.ts), written to the same record its own
// sidebar writes. Each acts on a workspace, which on the desktop is one chat:
// settling it moves it to the sidebar's Settled shelf and off every list; a
// visit tells the desktop a person had it on screen, so a turn read here stops
// showing as finished-and-unseen there too; mark unread moves the visit clock
// back to just before the chat's latest finish; a snooze sleeps it on its
// Snoozed shelf until a time, or wakes it now.
//
// Each change carries a command id, so one retried after the connection
// dropped is carried out once: a settle retried after an Undo does not settle
// the chat again. A visit is a stamp the desktop only moves forward, so it
// carries none.

/** A settle waits on the desktop writing the chat's state; a visit is a stamp and no more. */
export const CONVERSATION_SETTLE_TIMEOUT_MS = 10_000;
export const CONVERSATION_VISIT_TIMEOUT_MS = 5_000;

export interface SettledConversation {
  workspaceId: string;
  /** When the desktop settled it; null when the call un-settled it. */
  settledAt: number | null;
}

export interface VisitedConversation {
  workspaceId: string;
  /** The desktop's visit clock after the stamp; it only moves forward. */
  lastVisitedAt: number;
}

export interface SnoozedConversation {
  workspaceId: string;
  /** When it wakes; null when the call woke it. */
  snoozedUntil: number | null;
}

export interface MarkedUnreadConversation {
  workspaceId: string;
  /** The desktop's visit clock after the mark: just before the chat's latest finish, or earlier still. */
  lastVisitedAt: number;
}

/** What the chat surfaces need from the desktop; a harness may supply a fake of the same shape. */
export interface ChatLifecycleApi {
  settle(workspaceId: string, settled?: boolean): Promise<ApiResult<SettledConversation>>;
  /** No instant is sent: the desktop stamps its own clock, the one its turn ends are on. */
  visit(workspaceId: string): Promise<ApiResult<VisitedConversation>>;
  /** Refused when no agent in the chat has finished anything, in the desktop's words. */
  markUnread(workspaceId: string): Promise<ApiResult<MarkedUnreadConversation>>;
  /**
   * `until` is a time still ahead; null wakes the chat now. Refused while an
   * agent in it works and for a settled chat, in the desktop's words.
   */
  snooze(workspaceId: string, until: number | null): Promise<ApiResult<SnoozedConversation>>;
}

/** `conversation.snooze`'s instant: a whole millisecond to wake at, or null to wake now. */
export function snoozeInstant(until: number | null): number | null {
  return until === null ? null : Math.trunc(until);
}

function newCommandId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createChatLifecycleApi(
  target: { baseUrl: string; deviceToken: string },
  studio: DesktopStudioOptions = {},
): ChatLifecycleApi {
  /** One ask of the desktop's Studio, answered or failed in the phone's words within `timeoutMs`. */
  async function ask<T>(work: (client: StudioClient) => Promise<T>, timeoutMs: number): Promise<ApiResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([
        desktopStudio(target, studio).then(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("The desktop did not answer in time.")), timeoutMs);
        }),
      ]);
      return { ok: true, data };
    } catch (error) {
      const failed = studioFailure(error);
      return { ok: false, errorCode: failed.errorCode, message: failed.message };
    } finally {
      clearTimeout(timer);
    }
  }
  /** An answer the desktop gave, named for the chat it was about; a failure as it came. */
  function about<T, R>(workspaceId: string, done: ApiResult<T>, shape: (data: T) => R): ApiResult<R & { workspaceId: string }> {
    return done.ok ? { ok: true, data: { workspaceId, ...shape(done.data as T) } } : { ok: false, errorCode: done.errorCode, message: done.message };
  }
  return {
    async settle(workspaceId, settled = true) {
      const commandId = newCommandId();
      const done = await ask(
        (client) => client.rpc["conversation.settle"]({ workspaceId, commandId, ...(settled ? {} : { settled: false }) }),
        CONVERSATION_SETTLE_TIMEOUT_MS,
      );
      return about(workspaceId, done, (data) => ({ settledAt: data.settledAt }));
    },
    async visit(workspaceId) {
      const done = await ask((client) => client.rpc["conversation.visit"]({ workspaceId }), CONVERSATION_VISIT_TIMEOUT_MS);
      return about(workspaceId, done, (data) => ({ lastVisitedAt: data.lastVisitedAt }));
    },
    async markUnread(workspaceId) {
      const commandId = newCommandId();
      const done = await ask(
        (client) => client.rpc["conversation.markUnread"]({ workspaceId, commandId }),
        CONVERSATION_SETTLE_TIMEOUT_MS,
      );
      return about(workspaceId, done, (data) => ({ lastVisitedAt: data.lastVisitedAt }));
    },
    async snooze(workspaceId, until) {
      const commandId = newCommandId();
      const done = await ask(
        (client) => client.rpc["conversation.snooze"]({ workspaceId, commandId, until: snoozeInstant(until) }),
        CONVERSATION_SETTLE_TIMEOUT_MS,
      );
      return about(workspaceId, done, (data) => ({ snoozedUntil: data.snoozedUntil }));
    },
  };
}
