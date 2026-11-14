import type { StudioCanvasBoard } from "../../../packages/studio-protocol/src/public";
import { desktopStudio, studioFailure, type DesktopStudioOptions, type DesktopTarget } from "./desktopStudio";
import type { ApiErrorCode } from "./types";

// A paired desktop's Canvas boards, from the phone: the desktop's `canvas.list`
// and `canvas.picture` on its Studio protocol (desktopStudio.ts), answered by
// the same canvas service and tools its own Canvas pane and its agents use.
// Both only look, so both need `workspace:read` and nothing more; a paired
// device is bound to no workspace, so it reads every board on the machine,
// each with its project and the id that pictures it without naming a project.
//
// Reading an answer is pure and exported, so the regression suite reads the
// same rules the screens run.

const LIST_TIMEOUT_MS = 15_000;
/** The picture is drawn in a hidden window over there; the desktop's own wait for it. */
const PICTURE_TIMEOUT_MS = 45_000;
/** Big enough to pinch into on a phone, and the size a paired desktop asks for. */
export const CANVAS_PICTURE_MAX_EDGE = 1600;

/** One board as the phone lists it. */
export interface PhoneCanvasBoard {
  /** The board's id there (`canvas://ws_…/arch.excalidraw`). */
  id: string;
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
  | { ok: false; message: string; code: string | null; errorCode: ApiErrorCode };

/** `canvas.list`'s answer, read member by member: another machine's words are not trusted to be the shape they claim. */
export function readCanvasBoards(value: unknown): PhoneCanvasList {
  const record = isRecord(value) ? value : {};
  const boards = (Array.isArray(record.boards) ? record.boards : []).flatMap((entry): PhoneCanvasBoard[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || typeof entry.path !== "string" || !entry.path)
      return [];
    const row = entry as Partial<StudioCanvasBoard>;
    return [
      {
        id: entry.id,
        path: entry.path,
        name: typeof row.name === "string" && row.name ? row.name : canvasBoardName(entry.path),
        project: typeof row.project === "string" && row.project ? row.project : null,
        workspaceId: typeof row.workspaceId === "string" && row.workspaceId ? row.workspaceId : null,
        here: row.here === true,
        modifiedAt: typeof row.modifiedAt === "number" && Number.isFinite(row.modifiedAt) ? row.modifiedAt : 0,
        elementCount: typeof row.elementCount === "number" ? row.elementCount : -1,
      },
    ];
  });
  return { boards, note: typeof record.note === "string" && record.note ? record.note : null };
}

/** `canvas.picture`'s answer as an Image draws it: never built from anything but a PNG or a JPEG. Null when it carried none. */
export function readCanvasPicture(value: unknown): PhoneCanvasPicture | null {
  if (!isRecord(value) || typeof value.dataBase64 !== "string" || !value.dataBase64) return null;
  if (typeof value.mimeType !== "string" || !/^image\/(png|jpeg)$/u.test(value.mimeType)) return null;
  return {
    uri: `data:${value.mimeType};base64,${value.dataBase64}`,
    width: typeof value.width === "number" && value.width > 0 ? value.width : 0,
    height: typeof value.height === "number" && value.height > 0 ? value.height : 0,
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

/** `canvas.picture`'s params: the board, the project a path is read under, and the theme. */
export function buildCanvasPictureParams(input: {
  board: string;
  workspaceId: string | null;
  dark: boolean;
}): { board: string; workspaceId?: string; maxEdge: number; dark: boolean } {
  return {
    board: input.board,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    maxEdge: CANVAS_PICTURE_MAX_EDGE,
    dark: input.dark,
  };
}

/** What the Canvases screens need of a desktop; the harness supplies a fake of the same shape. */
export interface CanvasBoardsApi {
  /** Every board on the machine; `asker` marks the boards of that workspace's project as `here`. */
  list(asker: string | null): Promise<CanvasAnswer<PhoneCanvasList>>;
  /** A picture of one board, drawn over there. */
  picture(input: { board: string; workspaceId: string | null; dark: boolean }): Promise<CanvasAnswer<PhoneCanvasPicture>>;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The desktop did not answer in time.")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createCanvasBoardsApi(target: DesktopTarget, options: DesktopStudioOptions = {}): CanvasBoardsApi {
  const refused = (error: unknown) => ({ ok: false as const, ...studioFailure(error) });
  return {
    async list(asker) {
      try {
        const client = await desktopStudio(target, options);
        const listed = await withTimeout(client.request("canvas.list", asker ? { workspaceId: asker } : {}), LIST_TIMEOUT_MS);
        return { ok: true, data: readCanvasBoards(listed) };
      } catch (error) {
        return refused(error);
      }
    },
    async picture(input) {
      try {
        const client = await desktopStudio(target, options);
        const answer = await withTimeout(client.request("canvas.picture", buildCanvasPictureParams(input)), PICTURE_TIMEOUT_MS);
        const picture = readCanvasPicture(answer);
        return picture
          ? { ok: true, data: picture }
          : { ok: false, message: "", code: "no_picture", errorCode: "invalid_payload" };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
