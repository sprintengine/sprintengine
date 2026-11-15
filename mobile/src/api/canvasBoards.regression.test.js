/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A paired desktop's Canvas boards from the phone, on the desktop's Studio
// protocol: listed on `canvas.list`, pictured on `canvas.picture`, and each
// answer read member by member. A pairing that may not look is told so; a
// desktop from before the protocol, to update.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const {
  CANVAS_PICTURE_MAX_EDGE,
  buildCanvasPictureParams,
  canvasBoardName,
  createCanvasBoardsApi,
  isCanvasBoardId,
  readCanvasBoards,
  readCanvasPicture,
} = require(path.join(buildRoot, "src/api/canvasBoards.js"));
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

const STORE = `ws_${"a".repeat(24)}`;

let desktops = 0;
/** A paired desktop of its own for each case: the phone keeps one connection per desktop. */
const target = () => ({ baseUrl: `http://mac-mini-${++desktops}:4100`, deviceToken: "mctn_example" });

test("a machine's list is read row by row, with each board's project, id and workspace", () => {
  const read = readCanvasBoards({
    boards: [
      { id: `canvas://${STORE}/arch.excalidraw`, path: "arch.excalidraw", name: "arch", project: "atlas", here: true, workspaceId: "ws-2", elementCount: 3, modifiedAt: 1_700_000_000_000 },
      { id: `canvas://${STORE}/orphan.excalidraw`, path: "orphan.excalidraw", name: "orphan", project: null, workspaceId: null, elementCount: 0, modifiedAt: "not a time" },
      { path: "no-id.excalidraw" },
      "nonsense",
    ],
    note: "These are the 200 most recently changed of 240 boards on this machine.",
  });
  assert.deepEqual(read.boards[0], {
    id: `canvas://${STORE}/arch.excalidraw`,
    path: "arch.excalidraw",
    name: "arch",
    project: "atlas",
    workspaceId: "ws-2",
    here: true,
    modifiedAt: 1_700_000_000_000,
    elementCount: 3,
  });
  assert.deepEqual(
    read.boards.slice(1).map((board) => [board.name, board.project, board.workspaceId, board.modifiedAt, board.here]),
    [["orphan", null, null, 0, false]],
    "a row without an id is left out",
  );
  assert.match(read.note, /200 most recently changed/);
  assert.deepEqual(readCanvasBoards(null), { boards: [], note: null });
});

test("a picture is read from its bytes, and nothing but a PNG or a JPEG is drawn", () => {
  const answer = (mimeType, dataBase64 = "iVBORw0") => ({ mimeType, dataBase64, width: 720, height: 420 });
  assert.deepEqual(readCanvasPicture(answer("image/png")), { uri: "data:image/png;base64,iVBORw0", width: 720, height: 420 });
  assert.equal(readCanvasPicture(answer("image/jpeg")).uri.startsWith("data:image/jpeg;base64,"), true);
  assert.equal(readCanvasPicture(answer("image/svg+xml")), null);
  assert.equal(readCanvasPicture(answer("image/png", "")), null);
  assert.equal(readCanvasPicture({}), null);
});

test("a board's name comes from its path or its id", () => {
  assert.equal(canvasBoardName("arch.excalidraw"), "arch");
  assert.equal(canvasBoardName("diagrams/flow.excalidraw"), "flow");
  assert.equal(canvasBoardName(`canvas://${STORE}/Export Flow.excalidraw`), "Export Flow");
  assert.equal(canvasBoardName("diagrams\\win.excalidraw"), "win");
  assert.equal(isCanvasBoardId(`canvas://${STORE}/a.excalidraw`), true);
  assert.equal(isCanvasBoardId("arch"), false);
});

test("a picture is asked for in the phone's theme, at the size a paired desktop asks for, under a project only where it has one", () => {
  assert.equal(CANVAS_PICTURE_MAX_EDGE, 1600);
  assert.deepEqual(buildCanvasPictureParams({ board: "arch", workspaceId: "ws-1", dark: true }), {
    board: "arch",
    workspaceId: "ws-1",
    maxEdge: 1600,
    dark: true,
  });
  assert.deepEqual(buildCanvasPictureParams({ board: `canvas://${STORE}/a.excalidraw`, workspaceId: null, dark: false }), {
    board: `canvas://${STORE}/a.excalidraw`,
    maxEdge: 1600,
    dark: false,
  });
});

test("the phone lists every board on the desktop's Studio and asks for a picture there", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["workspaces:read"],
    answer: (method) =>
      method === "canvas.list"
        ? { boards: [{ id: `canvas://${STORE}/arch.excalidraw`, path: "arch.excalidraw", name: "arch", project: "atlas", here: false, workspaceId: "ws-2", elementCount: 1, modifiedAt: 1 }], note: null }
        : { mimeType: "image/png", dataBase64: "iVBORw0", width: 2, height: 3 },
  });
  const api = createCanvasBoardsApi(target(), { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  const all = await api.list(null);
  assert.ok(all.ok);
  assert.equal(all.data.boards[0].project, "atlas");
  await api.list("ws-chat");
  const picture = await api.picture({ board: `canvas://${STORE}/arch.excalidraw`, workspaceId: null, dark: true });
  assert.deepEqual(picture, { ok: true, data: { uri: "data:image/png;base64,iVBORw0", width: 2, height: 3 } });
  assert.deepEqual(desktop.requests, [
    { method: "canvas.list", params: {} },
    { method: "canvas.list", params: { workspaceId: "ws-chat" } },
    { method: "canvas.picture", params: { board: `canvas://${STORE}/arch.excalidraw`, maxEdge: 1600, dark: true } },
  ]);
  assert.equal(desktop.ticketHeaders[0].authorization, "Bearer mctn_example");
  closeDesktopStudios();
});

test("a refusal, a pairing that may not look, an older desktop and an answer with no picture each keep what a person can act on", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["workspaces:read"],
    answer: (method, params) => {
      if (method === "canvas.list") return { error: { code: "unavailable", message: "This Studio does not serve canvas.list." } };
      if (params.board === "gone") return { error: { code: "not_found", message: "There is no board at gone.excalidraw yet." } };
      if (params.board === "scoped") return { error: { code: "scope_required", message: "This pairing may not look." } };
      return { mimeType: "image/png", dataBase64: "", width: 1, height: 1 };
    },
  });
  const api = createCanvasBoardsApi(target(), { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  const listed = await api.list(null);
  assert.deepEqual([listed.ok, listed.code], [false, "unavailable"]);
  const gone = await api.picture({ board: "gone", workspaceId: "ws-1", dark: false });
  assert.deepEqual([gone.ok, gone.code, gone.message], [false, "not_found", "There is no board at gone.excalidraw yet."]);
  const scoped = await api.picture({ board: "scoped", workspaceId: "ws-1", dark: false });
  assert.deepEqual([scoped.ok, scoped.errorCode], [false, "unauthorized"]);
  const blank = await api.picture({ board: "arch", workspaceId: "ws-1", dark: false });
  assert.deepEqual([blank.ok, blank.code], [false, "no_picture"]);

  const older = fakeDesktopStudio({ answer: () => ({}), outdated: true });
  const old = await createCanvasBoardsApi(target(), { fetchImpl: older.fetchImpl, WebSocket: older.WebSocket }).list(null);
  assert.equal(!old.ok && old.errorCode, "command_not_supported");
  closeDesktopStudios();
});
