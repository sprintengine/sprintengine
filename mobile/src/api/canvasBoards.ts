import { createGatewayToolResultCaller, type GatewayToolAnswer } from "./tailnetWorkspaces";

// A paired desktop's Canvas boards, from the phone: the gateway's `canvas.list`
// and `canvas.screenshot` over the same stateless JSON-RPC POST `workspace.list`
// rides. Both only look, so both need `workspace:read` and nothing more; a
// paired device is bound to no workspace, so it reads every board on the
// machine and pictures one by its id without naming a project.
//
// A desktop that advertises `canvas-machine-boards` answers `scope: machine`
// with every board there, each with its project (null for a removed project)
// and the `id` the other canvas tools take. An older one is asked for one
// project's boards at a time, with no `scope`, which it has always answered;
// those rows carry no id, so a picture names its board by path, from that
// project. A machine that offers no canvas tools (a server with no desktop
// open) answers "Unknown tool".
//
// Reading an answer is pure and exported, so the regression suite reads the
// same rules the screens run.

const LIST_TIMEOUT_MS = 15_000;
/** The picture is drawn in a hidden window over there; the tool's own wait, as the desktop's mesh caller allows. */
const SCREENSHOT_TIMEOUT_MS = 45_000;
/** Big enough to pinch into on a phone, and the size a paired desktop asks for. */
export const CANVAS_PICTURE_MAX_EDGE = 1600;

/** One board as the phone lists it. */
export interface PhoneCanvasBoard {
  /** The board's id there (`canvas://ws_…/arch.excalidraw`); null from a machine that lists none. */
  id: string | null;
  /** Its path in its store or project (`arch.excalidraw`, `diagrams/flow.excalidraw`). */
  path: string;
  name: string;
  /** Its project there; null for a project that machine has removed. */
  project: string | null;
  /**
   * The workspace there the board is read under and a new chat starts beside:
   * the one in the board's folder. Null for a board whose project is gone.
   */
  workspaceId: string | null;
  /** In the project of the chat that asked; false when no chat asked. */
  here: boolean;
  /** Epoch milliseconds; 0 when the machine did not say. */
  modifiedAt: number;
  /** -1 when the machine did not say. */
  elementCount: number;
}

export interface PhoneCanvasList {
  boards: PhoneCanvasBoard[];
  /** The machine's own note on its answer: a list cut at its cap. */
  note: string | null;
}

export interface PhoneCanvasPicture {
  /** A `data:` URI an Image can draw. */
  uri: string;
  width: number;
  height: number;
}

export type CanvasAnswer<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code: string | null; errorCode: string };

/**
 * `canvas.list`'s answer, read member by member: another machine's words are
 * not trusted to be the shape they claim. `workspaceId` is the project an
 * answer without `scope` was asked for, which is every row's.
 */
export function readCanvasBoards(value: unknown, project: { workspaceId: string; name: string | null } | null): PhoneCanvasList {
  const record = isRecord(value) ? value : {};
  const boards = (Array.isArray(record.boards) ? record.boards : []).flatMap((entry): PhoneCanvasBoard[] => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !entry.path) return [];
    const modifiedAt = typeof entry.modifiedAt === "string" ? Date.parse(entry.modifiedAt) : Number.NaN;
    return [
      {
        id: typeof entry.id === "string" && entry.id ? entry.id : null,
        path: entry.path,
        name: typeof entry.name === "string" && entry.name ? entry.name : canvasBoardName(entry.path),
        project: project ? project.name : typeof entry.project === "string" && entry.project ? entry.project : null,
        workspaceId: project
          ? project.workspaceId
          : typeof entry.workspaceId === "string" && entry.workspaceId
            ? entry.workspaceId
            : null,
        here: project ? true : entry.here === true,
        modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
        elementCount: typeof entry.elementCount === "number" ? entry.elementCount : -1,
      },
    ];
  });
  return { boards, note: typeof record.note === "string" && record.note ? record.note : null };
}

/**
 * The picture in `canvas.screenshot`'s answer: its image block, never built
 * from anything but a PNG or a JPEG, and its size from the structured part.
 * Null when the answer carried no picture.
 */
export function readCanvasPicture(answer: Extract<GatewayToolAnswer, { ok: true }>): PhoneCanvasPicture | null {
  const image = answer.content.find((block) => block.type === "image");
  if (!image || typeof image.data !== "string" || !image.data || typeof image.mimeType !== "string") return null;
  if (!/^image\/(png|jpeg)$/u.test(image.mimeType)) return null;
  const { width, height } = answer.structured;
  return {
    uri: `data:${image.mimeType};base64,${image.data}`,
    width: typeof width === "number" && width > 0 ? width : 0,
    height: typeof height === "number" && height > 0 ? height : 0,
  };
}

/** A board's name from its path or id: the last segment, without `.excalidraw`. */
export function canvasBoardName(pathOrId: string): string {
  const last = pathOrId.replace(/\\/gu, "/").split("/").filter(Boolean).pop() ?? pathOrId;
  return last.replace(/\.excalidraw$/iu, "") || pathOrId;
}

/** Whether a board, as an agent named it, is a board id rather than a name or a path. */
export function isCanvasBoardId(board: string): boolean {
  return /^canvas:\/\//iu.test(board.trim());
}

/** `canvas.screenshot`'s arguments: the board, the project it is read under where it needs one, and the theme. */
export function buildCanvasScreenshotArgs(input: {
  board: string;
  workspaceId: string | null;
  dark: boolean;
}): Record<string, unknown> {
  return {
    board: input.board,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    maxEdge: CANVAS_PICTURE_MAX_EDGE,
    dark: input.dark,
  };
}

/** What the Canvases screens need from the tools; the harness supplies a fake of the same shape. */
export interface CanvasBoardsApi {
  /** Every board on the machine (`scope: machine`); `asker` marks the boards of that workspace's project as `here`. */
  listMachine(asker: string | null): Promise<CanvasAnswer<PhoneCanvasList>>;
  /** One project's boards, as every machine with canvas tools answers. */
  listProject(project: { workspaceId: string; name: string | null }): Promise<CanvasAnswer<PhoneCanvasList>>;
  /** A picture of one board, drawn over there. */
  picture(input: { board: string; workspaceId: string | null; dark: boolean }): Promise<CanvasAnswer<PhoneCanvasPicture>>;
}

export function createCanvasBoardsApi(options: { baseUrl: string; deviceToken: string }): CanvasBoardsApi {
  const call = createGatewayToolResultCaller(options);
  const refused = (answer: Extract<GatewayToolAnswer, { ok: false }>) => ({
    ok: false as const,
    message: answer.message,
    code: answer.code,
    errorCode: answer.errorCode,
  });
  return {
    async listMachine(asker) {
      const answer = await call("canvas.list", { scope: "machine", ...(asker ? { workspaceId: asker } : {}) }, LIST_TIMEOUT_MS);
      return answer.ok ? { ok: true, data: readCanvasBoards(answer.structured, null) } : refused(answer);
    },
    async listProject(project) {
      const answer = await call("canvas.list", { workspaceId: project.workspaceId }, LIST_TIMEOUT_MS);
      return answer.ok ? { ok: true, data: readCanvasBoards(answer.structured, project) } : refused(answer);
    },
    async picture(input) {
      const answer = await call("canvas.screenshot", buildCanvasScreenshotArgs(input), SCREENSHOT_TIMEOUT_MS);
      if (!answer.ok) return refused(answer);
      const picture = readCanvasPicture(answer);
      return picture
        ? { ok: true, data: picture }
        : { ok: false, message: "", code: "no_picture", errorCode: "invalid_payload" };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
