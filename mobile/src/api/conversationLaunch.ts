import { isConversationWirePermissionPreset } from "../../../packages/conversation-protocol/src/public";
import type { StudioConversationCreate } from "../../../packages/studio-protocol/src/public";
import { StudioError } from "../../../packages/client-runtime/src/public";
import {
  type ConversationWirePermissionPreset as ConversationPermissionPreset,
  type ConversationListedThread as ConversationThread,
} from "../../../packages/conversation-protocol/src/public";
import { plainLineBreaks } from "../features/conversations/sendRules";
import { desktopStudio, type DesktopStudioOptions } from "./desktopStudio";

// Starting a chat on a paired desktop: `conversation.create` on the desktop's
// Studio protocol (desktopStudio.ts). The desktop starts a new chat in the
// chosen project's folder, starts its session and sends the prompt as its
// first message, and answers once the session is up, without waiting for the
// reply. The phone then subscribes to the conversation like any other.
//
// Everything that decides what is sent and what an answer means is pure and
// exported, so the regression suite reads the same rules the screen runs.

// A launch waits on a real CLI starting on the desktop; a paired desktop
// allows a minute for the same call.
export const CONVERSATION_CREATE_TIMEOUT_MS = 60_000;

export interface CreateConversationInput {
  /** The project to start in; ignored with `noProject`. */
  workspaceId: string;
  /**
   * Start the chat under no project, in a folder of its own on the desktop,
   * in place of `workspaceId`. Only to a desktop that advertises
   * `new-chat-no-project`: an older one refuses a call with no workspace.
   */
  noProject?: boolean;
  /** The chat's first message. */
  prompt?: string;
  /** CLI plugin id from `cli.runtime.list`; omitted takes the desktop's last-selected CLI. */
  cli?: string;
  /** That CLI's model id; the CLI's own default when omitted. */
  cliModel?: string;
  /**
   * Omitted, the preset the desktop chose for that CLI. `manual` and `auto`
   * only to a desktop that declares `conversation-permission-modes`: an older
   * one reads either as `none`.
   */
  permissionPreset?: ConversationPermissionPreset;
  /**
   * Start the chat as a chat of its own in the workspace's folder, rather than
   * as one more agent inside that workspace. A workspace on the desktop is one
   * chat and its name is that chat's title, so a phone's New added to an
   * existing workspace wore the older chat's title and sat inside it. A
   * desktop from before the argument ignores it and does the latter.
   */
  newChat?: boolean;
  /**
   * With `newChat`, start the chat in a worktree of its own, cut as the
   * desktop's New chat cuts one: from its worktree pool, on the project's
   * branch, filed under the project. Only to a desktop that advertises
   * `new-chat-worktree`: an older one skips the argument and starts the chat
   * in the checkout. Refused as `worktree_unavailable` (a folder that is not
   * a repository, or one on an SSH machine), with nothing started.
   */
  worktree?: boolean;
  /**
   * The effort the chat runs at, one of the CLI's `reasoningLevels`. Only to a
   * desktop that advertises `new-chat-effort`; another level is refused as
   * `unsupported_effort`. Omitted, the CLI's own default.
   */
  effort?: string;
}

/** What the desktop answers once the session is up. */
export interface LaunchedConversation {
  workspaceId: string;
  agentId: string;
  name: string;
  cli: string;
  providerId: string;
  modelId: string;
  sessionId: string;
}

/**
 * `unsupported` means the desktop is on a build from before the Studio protocol: nothing
 * the phone can send will start a chat there, and updating Studio is the one
 * way on.
 */
export type ConversationLaunchFailure = "unsupported" | "refused" | "unavailable" | "unpaired";

export type CreateConversationResult =
  | { ok: true; conversation: LaunchedConversation }
  | {
      ok: false;
      failure: ConversationLaunchFailure;
      title: string;
      message?: string;
      /** The desktop's refusal code, where it gave one New can act on (`worktree_unavailable`). */
      code?: string;
    };

/** What `conversation.create` is asked, without the command id the call adds. */
export type ConversationCreateArgs = StudioConversationCreate;

/**
 * The create's params: only what was actually chosen. An empty string would
 * be a choice of nothing, and the desktop reads a present field as a choice.
 */
export function buildConversationCreateArgs(input: CreateConversationInput): ConversationCreateArgs {
  const args: Record<string, unknown> = input.noProject ? { noProject: true } : { workspaceId: input.workspaceId.trim() };
  const prompt = input.prompt === undefined ? "" : plainLineBreaks(input.prompt).trim();
  if (prompt) args.prompt = prompt;
  if (input.cli?.trim()) args.cli = input.cli.trim();
  if (input.cliModel?.trim()) args.model = input.cliModel.trim();
  if (isConversationWirePermissionPreset(input.permissionPreset)) {
    args.permissionPreset = input.permissionPreset;
  }
  if (input.newChat) args.newChat = true;
  // A worktree is where a new chat is born; the desktop refuses one asked
  // for a chat joining a workspace, so it is never sent without `newChat`.
  // "No project" takes the workspace's place, and no worktree: there is no
  // checkout to cut one from.
  if (input.newChat && input.worktree && !input.noProject) args.worktree = true;
  const effort = input.effort?.trim();
  if (effort) args.effort = effort;
  return args as ConversationCreateArgs;
}

/**
 * What the desktop's refusal means, in the words the screen shows.
 *
 * The desktop says each refusal in its own stable sentence, written for any
 * client; the codes a person can act on are said again here in their terms.
 * A code this phone does not know keeps the desktop's sentence.
 */
export function readConversationCreateFailure(error: unknown, machineName: string): CreateConversationResult {
  const machine = machineName.trim() || "The desktop";
  const code = error instanceof StudioError ? error.code : "";
  const detail = error instanceof Error ? error.message : "";
  switch (code) {
    case "unauthorized":
    case "revoked":
      return { ok: false, failure: "unpaired", title: `This phone is no longer paired with ${machine}.`, message: "Pair again from Settings." };
    case "peer_mismatch":
      return { ok: false, failure: "unpaired", title: detail };
    case "outdated":
    case "unknown_method":
      return chatLaunchUnsupported(machine);
    case "unavailable":
    case "disconnected":
    case "offline":
    case "":
      return { ok: false, failure: "unavailable", title: `${machine} did not answer.`, message: detail || "Is Tailscale up on both devices?" };
    default:
      return refusal(code, detail, machine);
  }
}

/** What a desktop from before the Studio protocol earns. */
export function chatLaunchUnsupported(machine: string): CreateConversationResult {
  return {
    ok: false,
    failure: "unsupported",
    title: `${machine} cannot start chat agents yet.`,
    message: "Update SprintEngine Studio there to start one from the phone.",
  };
}

function refusal(code: string, detail: string, machine: string): CreateConversationResult {
  const refused = (title: string, message?: string, carried?: string): CreateConversationResult => ({
    ok: false,
    failure: "refused",
    title,
    message,
    ...(carried ? { code: carried } : {}),
  });
  switch (code) {
    case "scope_required":
      return refused(`This phone may not start chats on ${machine}.`, "Pair again with chat control to start one here.");
    case "unknown_workspace":
      return refused(`That project is no longer open on ${machine}.`, "Open it in Studio there, then try again.");
    case "workspace_folder_missing":
      return refused(`That project has no folder on ${machine}, so there is nowhere to start the chat.`);
    case "no_cli_selected":
      return refused(`${machine} has no CLI chosen yet.`, "Pick one under Agent and model.");
    case "cli_not_conversational":
      return refused(`That CLI cannot run as a chat on ${machine}.`, "Pick another under Agent and model.");
    // The desktop's reason says which ("…is not a git repository…", an SSH
    // machine's folder, git's own failure), and nothing was started: New
    // keeps the prompt and offers to start without one.
    case "worktree_unavailable":
      return refused(`${machine} could not make a worktree for the chat.`, detail || undefined, code);
    case "unsupported_effort":
      return refused(`${machine} does not offer that effort for this CLI.`, detail || "Pick another under Agent and model.", code);
    default:
      return refused(`${machine} could not start the chat.`, detail || undefined);
  }
}

/**
 * The thread to open when the list has not caught up with the launch yet.
 *
 * Only what the desktop said is filled in; the rest is what a chat that has just
 * started is. The conversation screen replaces all of it from its first
 * snapshot, so a guess here lasts one frame.
 */
export function threadFromLaunch(
  conversation: LaunchedConversation,
  options: { now: number; permissionPreset?: ConversationPermissionPreset },
): ConversationThread {
  return {
    workspaceId: conversation.workspaceId,
    agentId: conversation.agentId,
    ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
    title: conversation.name || "Chat",
    phase: "starting",
    updatedAt: options.now,
    createdAt: options.now,
    providerId: conversation.providerId,
    modelId: conversation.modelId,
    turnCount: 0,
    lastSeq: 0,
    ...(options.permissionPreset ? { permissionPreset: options.permissionPreset } : {}),
  };
}

/** The listed thread for a launch, which carries the catalog and capabilities the create answer does not. */
export function findLaunchedThread(
  threads: readonly ConversationThread[],
  conversation: Pick<LaunchedConversation, "workspaceId" | "agentId">,
): ConversationThread | null {
  return (
    threads.find((thread) => thread.workspaceId === conversation.workspaceId && thread.agentId === conversation.agentId) ??
    null
  );
}

/** A command id for one New: its retries carry the same id, so the desktop starts the chat once. */
function newCommandId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Starts a chat on one paired desktop. Never throws: a desktop that did not
 * answer is a result the screen shows, like any refusal.
 */
export async function createConversation(
  target: { baseUrl: string; deviceToken: string; machineName: string },
  input: CreateConversationInput,
  options: DesktopStudioOptions & { timeoutMs?: number; commandId?: string } = {},
): Promise<CreateConversationResult> {
  const machine = target.machineName.trim() || "The desktop";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooLong = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? CONVERSATION_CREATE_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      desktopStudio(target, options).then((client) =>
        client.rpc["conversation.create"]({ ...buildConversationCreateArgs(input), commandId: options.commandId ?? newCommandId() }),
      ),
      tooLong,
    ]);
    // A minute is long past a healthy start, but the desktop may still have
    // started it: say where it would be rather than that it failed.
    if (answer === "timeout")
      return { ok: false, failure: "unavailable", title: `${machine} took too long to start the chat.`, message: "If it started, it is under Chats." };
    const conversation = answer.conversation;
    if (!conversation.workspaceId || !conversation.agentId) {
      return { ok: false, failure: "refused", title: `${machine} started the chat but did not say which one it is.`, message: "Find it under Chats." };
    }
    return {
      ok: true,
      conversation: {
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
        name: conversation.name ?? "",
        cli: conversation.cli ?? "",
        providerId: conversation.providerId ?? "",
        modelId: conversation.modelId ?? "",
        sessionId: conversation.sessionId ?? "",
      },
    };
  } catch (error) {
    return readConversationCreateFailure(error, machine);
  } finally {
    clearTimeout(timer);
  }
}
