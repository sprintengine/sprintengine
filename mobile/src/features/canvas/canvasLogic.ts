import {
  canvasBoardName,
  isCanvasBoardId,
  type CanvasAnswer,
  type CanvasBoardsApi,
  type PhoneCanvasBoard,
} from "../../api/canvasBoards";
import type { DesktopWorkspace, WorkspacesApi } from "../../api/tailnetWorkspaces";
import { declaresCanvasMachineBoards } from "../../api/tailnetTransport";
import { formatChatSettledAt } from "../conversations/conversationListLogic";

// The phone's Canvases, as rules: how each paired desktop is asked for its
// boards, what a row says, what a picture is asked for, and where Continue in
// a new chat starts. Pure and free of React Native, so the regression suite
// reads the same rules the screens run. The words are the desktop's where it
// has words for the same thing (its Canvas pane's All boards, and its picture
// of a board on a paired machine).

/** What a row of every board calls a project nothing remembers. The desktop's `CANVAS_DELETED_PROJECT_LABEL`. */
export const CANVAS_DELETED_PROJECT_LABEL = "Deleted project";

export function canvasProjectLabel(project: string | null): string {
  return project ?? CANVAS_DELETED_PROJECT_LABEL;
}

/**
 * The first message of "Continue in a new chat", word for word the desktop's
 * (`canvasContinuePrompt`): it names the board by its id where there is one,
 * else by its path, so the chat picks up the same file wherever it runs.
 */
export function canvasContinuePrompt(name: string, board: string): string {
  return `I want to keep working on the Canvas board "${name}". Pass ${board} as \`board\` to every canvas tool, because a bare name could mean another board. Open it with canvas.open, read it with canvas.describe, then ask me what to change.`;
}

/**
 * How a desktop is asked for its boards.
 *
 * - `machine`: it advertises `canvas-machine-boards`, so one call lists every
 *   board there, removed projects' included.
 * - `project`: an older desktop, asked from a chat: that chat's project alone.
 * - `projects`: an older desktop, asked from home: each project it has open,
 *   one call apiece.
 */
export type CanvasListMode = "machine" | "project" | "projects";

export function canvasListMode(
  session: { tailnetCapabilities?: string[] },
  chat: { workspaceId: string } | null,
): CanvasListMode {
  if (declaresCanvasMachineBoards(session)) return "machine";
  return chat ? "project" : "projects";
}

/** What the list says, in words, when it is not the whole machine's. Null when it is. */
export function canvasListModeNote(mode: CanvasListMode, machine: string): string | null {
  switch (mode) {
    case "machine":
      return null;
    // The desktop's own sentence for the same answer from the same machine.
    case "project":
      return `${machine} lists only this project's boards. Update SprintEngine Studio there to see all of them.`;
    case "projects":
      return `${machine} lists its boards one project at a time, so these are the boards of the projects open there, and none from a removed project. Update SprintEngine Studio there to see all of them.`;
  }
}

/** A refusal of a list or a picture, as a person can act on it. */
export function canvasRefusalWords(
  machine: string,
  failure: Extract<CanvasAnswer<unknown>, { ok: false }>,
  what: "list" | "picture",
): string {
  // A machine that keeps no canvas tools running: a server with no desktop open offers none.
  if (failure.code === "unknown_tool")
    return `${machine} is not offering its boards right now. Open SprintEngine Studio there and try again.`;
  if (failure.errorCode === "unauthorized")
    return `This phone may not read ${machine}'s projects, so not its boards. Pair again with project access.`;
  if (failure.code === "no_picture") return `${machine} sent no picture of this board.`;
  if (failure.message) return failure.message;
  return what === "list" ? `${machine} did not list its boards.` : `${machine} could not draw this board.`;
}

/**
 * The projects an older desktop is asked about from home: one workspace per
 * project, the checkout where it is open, else the first of its worktrees.
 * A workspace with no folder is no project and has no boards.
 */
export function canvasProjectsToAsk(
  workspaces: readonly Pick<DesktopWorkspace, "workspaceId" | "projectName" | "projectKey" | "worktree" | "projectless">[],
): { workspaceId: string; name: string }[] {
  const chosen = new Map<string, { workspaceId: string; name: string; checkout: boolean }>();
  for (const workspace of workspaces) {
    if (!workspace.projectKey || workspace.projectless) continue;
    const checkout = !workspace.worktree;
    const held = chosen.get(workspace.projectKey);
    if (held && (held.checkout || !checkout)) continue;
    chosen.set(workspace.projectKey, { workspaceId: workspace.workspaceId, name: workspace.projectName, checkout });
  }
  return [...chosen.values()].map(({ workspaceId, name }) => ({ workspaceId, name }));
}

/**
 * Several projects' lists as one, the most recently changed first, as one
 * machine-wide list is. A board two projects both answered (two clones of
 * one store) is listed once.
 */
export function mergeCanvasLists(lists: readonly (readonly PhoneCanvasBoard[])[]): PhoneCanvasBoard[] {
  const seen = new Set<string>();
  const merged: PhoneCanvasBoard[] = [];
  for (const board of lists.flat()) {
    const key = board.id ?? `${board.workspaceId ?? ""}\u0000${board.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(board);
  }
  return merged.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

/** The line under a board's name: its project, how much is on it, and when it last changed. */
export function canvasBoardMeta(board: PhoneCanvasBoard): string {
  const count =
    board.elementCount < 0 ? null : board.elementCount === 0 ? "Empty" : `${board.elementCount} ${board.elementCount === 1 ? "element" : "elements"}`;
  return [canvasProjectLabel(board.project), count].filter(Boolean).join(" · ");
}

/** When it last changed, as the chat list's bare times say it; null when the machine did not say. */
export function canvasBoardChanged(board: Pick<PhoneCanvasBoard, "modifiedAt">, now: number): string | null {
  return board.modifiedAt > 0 ? formatChatSettledAt(board.modifiedAt, now) : null;
}

/**
 * One board on one desktop, as its picture screen opens it: a row of the
 * list, or the board a chat's agent drew on.
 */
export interface CanvasBoardTarget {
  deviceId: string;
  /** Its id, where the machine gave one or the agent named it by one. */
  id: string | null;
  /** Its path, or the bare name the agent used, read in `workspaceId`'s project. */
  path: string;
  name: string;
  /** Its project; null for a removed one, undefined where nobody said (a board opened from a chat). */
  project?: string | null;
  /** The workspace in the board's folder; null where its project is gone. */
  workspaceId: string | null;
  /** The chat it was opened from, whose project a board named by path is read in. */
  asker: string | null;
}

/**
 * The board a chat's agent drew on, as its picture screen opens it, or null
 * when the agent never named one (its tools then used the project's newest
 * board, which the phone cannot name). A bare name is read in the chat's own
 * project, as the agent's tools read it; an id needs no project, and is asked
 * under the chat's all the same, which every machine with ids answers.
 */
export function chatCanvasBoard(
  named: string | null,
  chat: { deviceId: string; workspaceId: string },
): CanvasBoardTarget | null {
  const board = named?.trim();
  if (!board) return null;
  const id = isCanvasBoardId(board);
  return {
    deviceId: chat.deviceId,
    id: id ? board : null,
    path: id ? board.slice(board.indexOf("/", "canvas://".length) + 1) || board : board,
    name: canvasBoardName(board),
    workspaceId: id ? null : chat.workspaceId,
    asker: chat.workspaceId,
  };
}

/** A row of the list as its picture screen opens it. */
export function canvasRowTarget(deviceId: string, board: PhoneCanvasBoard, asker: string | null): CanvasBoardTarget {
  return {
    deviceId,
    id: board.id,
    path: board.path,
    name: board.name,
    project: board.project,
    workspaceId: board.workspaceId,
    asker,
  };
}

/**
 * What `canvas.screenshot` is asked for: the board by its id where it has
 * one, which needs no project, else by its path in the project it was listed
 * under. Under the asking chat where there is one, as a paired desktop asks.
 */
export function canvasPictureRequest(target: CanvasBoardTarget): { board: string; workspaceId: string | null } {
  if (target.id) return { board: target.id, workspaceId: target.asker };
  return { board: target.path, workspaceId: target.workspaceId ?? target.asker };
}

/**
 * Where "Continue in a new chat" starts, as the desktop decides it: beside the
 * board, in the folder it was drawn in; failing that in the project of the
 * chat that asked; failing that under no project, where the desktop takes
 * one (`new-chat-no-project`). A board whose project is gone is still there,
 * and any chat can reach it by its id, so a missing folder is no reason to
 * refuse it, except on a desktop that can start no chat without a project.
 */
export type CanvasContinueTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "no-project" }
  | { kind: "refused"; message: string };

export function canvasContinueTarget(
  target: CanvasBoardTarget,
  input: { noProject: boolean; machine: string },
): CanvasContinueTarget {
  const beside = target.workspaceId ?? target.asker;
  if (beside) return { kind: "workspace", workspaceId: beside };
  if (input.noProject) return { kind: "no-project" };
  return {
    kind: "refused",
    message: `This board's project is gone from ${input.machine}, and ${input.machine} cannot start a chat without one. Update SprintEngine Studio there, or continue it from a chat on ${input.machine}.`,
  };
}

/** The first message of the chat that continues this board. */
export function canvasContinueMessage(target: CanvasBoardTarget): string {
  return canvasContinuePrompt(target.name, target.id ?? target.path);
}

/** One desktop's boards as the list draws them: the rows, and what it says about them in words. */
export interface CanvasDesktopRead {
  /** Null when the desktop could not list any. */
  boards: PhoneCanvasBoard[] | null;
  /** Sentences under the desktop's rows: whose boards these are, and what was cut. */
  notes: string[];
  /** Why there are no rows, when the desktop refused or did not answer. */
  error: string | null;
}

/** How many of an older desktop's projects are asked at once. */
const PROJECT_READS_AT_ONCE = 4;

/**
 * Asks one desktop for its boards, as its capabilities allow (`canvasListMode`),
 * and never throws: a refusal is a read with words in it. `chat` is the chat
 * the list was opened from, when it was opened from one on this desktop.
 */
export async function readCanvasDesktop(input: {
  machine: string;
  session: { tailnetCapabilities?: string[] };
  chat: { workspaceId: string; projectName: string | null } | null;
  boards: CanvasBoardsApi;
  workspaces: Pick<WorkspacesApi, "listWorkspaces">;
}): Promise<CanvasDesktopRead> {
  const { machine, chat } = input;
  const mode = canvasListMode(input.session, chat);
  const modeNote = canvasListModeNote(mode, machine);
  const failed = (failure: Extract<CanvasAnswer<unknown>, { ok: false }>): CanvasDesktopRead => ({
    boards: null,
    notes: [],
    error: canvasRefusalWords(machine, failure, "list"),
  });
  try {
    if (mode !== "projects") {
      const answer =
        mode === "machine"
          ? await input.boards.listMachine(chat?.workspaceId ?? null)
          : await input.boards.listProject({ workspaceId: chat!.workspaceId, name: chat!.projectName });
      if (!answer.ok) return failed(answer);
      return { boards: answer.data.boards, notes: [modeNote, answer.data.note].filter((note): note is string => !!note), error: null };
    }
    const listed = await input.workspaces.listWorkspaces();
    if (!listed.ok) return { boards: null, notes: [], error: listed.message ?? `${machine} did not list its projects.` };
    const projects = canvasProjectsToAsk(listed.data ?? []);
    const answers: { name: string; answer: CanvasAnswer<{ boards: PhoneCanvasBoard[] }> }[] = [];
    for (let start = 0; start < projects.length; start += PROJECT_READS_AT_ONCE) {
      const batch = projects.slice(start, start + PROJECT_READS_AT_ONCE);
      answers.push(
        ...(await Promise.all(batch.map(async (project) => ({ name: project.name, answer: await input.boards.listProject(project) })))),
      );
      // A machine with no canvas tools says so on its first answer; the rest would say the same.
      const unknown = answers.find(({ answer }) => !answer.ok && answer.code === "unknown_tool");
      if (unknown && !unknown.answer.ok) return failed(unknown.answer);
    }
    const lists = answers.flatMap(({ answer }) => (answer.ok ? [answer.data.boards] : []));
    const missing = answers.flatMap(({ name, answer }) => (answer.ok ? [] : [name]));
    if (answers.length > 0 && lists.length === 0) {
      const first = answers[0].answer;
      if (!first.ok) return failed(first);
    }
    return {
      boards: mergeCanvasLists(lists),
      notes: [
        modeNote,
        missing.length ? `${missing.join(", ")} did not list ${missing.length === 1 ? "its" : "their"} boards.` : null,
      ].filter((note): note is string => !!note),
      error: null,
    };
  } catch {
    return { boards: null, notes: [], error: `${machine} did not answer.` };
  }
}

/** A board target as the CanvasBoard route carries it: flat, so a deep link reaches it. */
export function canvasTargetParams(target: CanvasBoardTarget): {
  deviceId: string;
  name: string;
  path: string;
  id?: string | null;
  project?: string | null;
  workspaceId?: string | null;
  asker?: string | null;
} {
  return {
    deviceId: target.deviceId,
    name: target.name,
    path: target.path,
    id: target.id,
    ...(target.project !== undefined ? { project: target.project } : {}),
    workspaceId: target.workspaceId,
    asker: target.asker,
  };
}

/** The route's params back as a target; a link leaves out what it does not know. */
export function canvasTargetFromParams(params: {
  deviceId: string;
  name: string;
  path: string;
  id?: string | null;
  project?: string | null;
  workspaceId?: string | null;
  asker?: string | null;
}): CanvasBoardTarget {
  return {
    deviceId: params.deviceId,
    id: params.id || null,
    path: params.path,
    name: params.name,
    ...(params.project !== undefined ? { project: params.project } : {}),
    workspaceId: params.workspaceId || null,
    asker: params.asker || null,
  };
}
