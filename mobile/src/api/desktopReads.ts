import type { StudioClient } from "../../../packages/client-runtime/src/public";
import {
  studioGrantAllows,
  type StudioBacklogItem,
  type StudioBacklogUpdate,
  type StudioBacklogWorkspace,
  type StudioPullRequestDetail,
  type StudioPullRequestDiffPage,
  type StudioShare,
} from "../../../packages/studio-protocol/src/public";
import { desktopStudio, onDesktopStudioBack, studioFailure, type DesktopStudioOptions, type DesktopTarget } from "./desktopStudio";
import type { ApiResult } from "./types";

// What the phone reads of a paired desktop beside its chats, on the desktop's
// Studio protocol (desktopStudio.ts): its projects' backlogs, the pages it
// shares on the tailnet, and a pull request read in full. The desktop says
// when a backlog moves (`backlog.changed`), so nothing here polls.
//
// What the phone may do is the desktop's answer, never a guess: a control is
// drawn only where the desktop serves the method and this pairing's grant, as
// the desktop reads it now, allows it.

const READ_TIMEOUT_MS = 15_000;
/** A pull request's checks and files come from GitHub, through the desktop. */
const PULL_REQUEST_TIMEOUT_MS = 30_000;

/** Everything the Backlog, Web and fleet screens draw from one desktop. */
export interface DesktopSnapshot {
  backlog: StudioBacklogWorkspace[];
  webTargets: StudioShare[];
  /** This pairing may change an item's status and triage there. */
  canUpdateBacklog: boolean;
  /** The desktop reads a pull request in full for this pairing. */
  canReadPullRequests: boolean;
}

/** One ask of the desktop's Studio, answered or failed in the phone's words within `timeoutMs`. */
async function ask<T>(
  target: DesktopTarget,
  work: (client: StudioClient) => Promise<T>,
  options: DesktopStudioOptions & { timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      desktopStudio(target, options).then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The desktop did not answer in time.")), options.timeoutMs ?? READ_TIMEOUT_MS);
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

/** Whether this connection may call a method: the desktop serves its family, and the grant allows it. */
function may(client: StudioClient, capability: Parameters<StudioClient["supports"]>[0], method: Parameters<typeof studioGrantAllows>[1]): boolean {
  return client.supports(capability) && studioGrantAllows(client.welcome.grant, method);
}

/**
 * The desktop's backlogs and shares, each read only where this pairing may.
 * A pairing that may read neither is answered with an empty snapshot, not a
 * failure: there is nothing for it to see.
 */
export function readDesktopSnapshot(target: DesktopTarget, options: DesktopStudioOptions = {}): Promise<ApiResult<DesktopSnapshot>> {
  return ask(
    target,
    async (client) => {
      const [backlog, shares] = await Promise.all([
        may(client, "backlog", "backlog.list") ? client.rpc["backlog.list"]({}) : Promise.resolve({ workspaces: [] }),
        may(client, "shares", "shares.list") ? client.rpc["shares.list"]({}) : Promise.resolve({ shares: [] }),
      ]);
      return {
        backlog: backlog.workspaces,
        webTargets: shares.shares,
        canUpdateBacklog: may(client, "backlog", "backlog.update"),
        canReadPullRequests: may(client, "pull-request-reads", "pullRequests.detail"),
      };
    },
    options,
  );
}

function newCommandId(): string {
  return `backlog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Change one item's status or triage there, once, under a command id of its own. */
export function updateDesktopBacklogItem(
  target: DesktopTarget,
  update: StudioBacklogUpdate,
  options: DesktopStudioOptions = {},
): Promise<ApiResult<{ item: StudioBacklogItem | null }>> {
  const commandId = newCommandId();
  return ask(target, (client) => client.rpc["backlog.update"]({ ...update, commandId }), options);
}

/**
 * Hear the desktop say its backlogs moved, while the returned stop is not
 * called. The subscription comes back with the connection by itself, and
 * nothing said while the socket was down is replayed, so a connection back
 * after a drop is heard as a change too. A pairing that may not read the
 * backlog hears nothing.
 */
export function watchDesktopBacklog(
  target: DesktopTarget,
  onChanged: () => void,
  options: DesktopStudioOptions = {},
): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let stopBack: (() => void) | null = null;
  void desktopStudio(target, options).then(
    (client) => {
      if (stopped || !may(client, "backlog", "backlog.list")) return;
      unsubscribe = client.subscribe("backlog.changed", {}, { onPayload: () => onChanged() });
      stopBack = onDesktopStudioBack(target, () => {
        if (!stopped) onChanged();
      });
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    unsubscribe?.();
    stopBack?.();
  };
}

/** One pull request in full, by its GitHub URL. */
export function readPullRequestDetail(
  target: DesktopTarget,
  url: string,
  options: DesktopStudioOptions = {},
): Promise<ApiResult<StudioPullRequestDetail>> {
  return ask(target, (client) => client.rpc["pullRequests.detail"]({ url }), { ...options, timeoutMs: PULL_REQUEST_TIMEOUT_MS });
}

/** A page of one changed file's diff, from line `offset`. */
export function readPullRequestDiff(
  target: DesktopTarget,
  input: { url: string; path: string; offset?: number },
  options: DesktopStudioOptions = {},
): Promise<ApiResult<StudioPullRequestDiffPage>> {
  return ask(target, (client) => client.rpc["pullRequests.diff"](input), { ...options, timeoutMs: PULL_REQUEST_TIMEOUT_MS });
}
