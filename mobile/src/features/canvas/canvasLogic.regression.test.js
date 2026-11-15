/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The phone's Canvases: how a desktop's list is read, what a picture is asked
// for, and where Continue in a new chat starts, in the desktop's own words.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build/mobile");
const {
  CANVAS_DELETED_PROJECT_LABEL,
  canvasBoardMeta,
  canvasContinueMessage,
  canvasContinuePrompt,
  canvasContinueTarget,
  canvasPictureRequest,
  canvasProjectLabel,
  canvasRefusalWords,
  canvasRowTarget,
  canvasTargetFromParams,
  canvasTargetParams,
  chatCanvasBoard,
  readCanvasDesktop,
} = require(path.join(buildRoot, "src/features/canvas/canvasLogic.js"));

const STORE = `ws_${"a".repeat(24)}`;
const ID = `canvas://${STORE}/arch.excalidraw`;

const board = (overrides = {}) => ({
  id: ID,
  path: "arch.excalidraw",
  name: "arch",
  project: "atlas",
  workspaceId: "ws-2",
  here: false,
  modifiedAt: 1_000,
  elementCount: 3,
  ...overrides,
});

const fakeBoards = (answer) => {
  const calls = [];
  return {
    calls,
    api: {
      async list(asker) {
        calls.push(asker);
        return answer;
      },
      async picture() {
        throw new Error("not asked here");
      },
    },
  };
};
const ok = (boards, note = null) => ({ ok: true, data: { boards, note } });
const refused = (code, message = "", errorCode = "invalid_payload") => ({ ok: false, code, message, errorCode });

test("Continue in a new chat sends the desktop's own first message, naming the board by id", () => {
  assert.equal(
    canvasContinuePrompt("arch", ID),
    `I want to keep working on the Canvas board "arch". Pass ${ID} as \`board\` to every canvas tool, because a bare name could mean another board. Open it with canvas.open, read it with canvas.describe, then ask me what to change.`,
  );
  // A board an agent named by path, with no id, is named by its path.
  assert.match(canvasContinueMessage(chatCanvasBoard("diagrams/flow.excalidraw", { deviceId: "dev_1", workspaceId: "ws-1" })), /Pass diagrams\/flow\.excalidraw as/);
});

test("a removed project reads as the desktop says it", () => {
  assert.equal(CANVAS_DELETED_PROJECT_LABEL, "Deleted project");
  assert.equal(canvasProjectLabel(null), "Deleted project");
  assert.equal(canvasBoardMeta(board({ project: null, elementCount: 0 })), "Deleted project · Empty");
  assert.equal(canvasBoardMeta(board({ elementCount: 1 })), "atlas · 1 element");
  assert.equal(canvasBoardMeta(board({ elementCount: -1 })), "atlas");
});

test("a desktop serving no boards says to open Studio there, in a person's words", () => {
  assert.equal(
    canvasRefusalWords("mac-mini", refused("unavailable", "This Studio does not serve canvas.list."), "list"),
    "mac-mini is not offering its boards right now. Open SprintEngine Studio there and try again.",
  );
  assert.match(canvasRefusalWords("mac-mini", refused(null, "nope", "unauthorized"), "list"), /may not read mac-mini's projects/);
  assert.equal(canvasRefusalWords("mac-mini", refused("no_picture"), "picture"), "mac-mini sent no picture of this board.");
  assert.equal(canvasRefusalWords("mac-mini", refused("canvas_module_disabled", "The Canvas module is disabled."), "list"), "The Canvas module is disabled.");
  assert.equal(canvasRefusalWords("mac-mini", refused(null, ""), "list"), "mac-mini did not list its boards.");
});

test("a desktop is read in one call, under the asking chat where there is one", async () => {
  const fake = fakeBoards(ok([board()], "capped"));
  const read = await readCanvasDesktop({ machine: "mac-mini", chat: { workspaceId: "ws-chat" }, boards: fake.api });
  assert.deepEqual(fake.calls, ["ws-chat"]);
  assert.deepEqual([read.boards.length, read.notes, read.error], [1, ["capped"], null]);
  const home = fakeBoards(ok([]));
  await readCanvasDesktop({ machine: "mac-mini", chat: null, boards: home.api });
  assert.deepEqual(home.calls, [null]);
});

test("a desktop that refuses is a read with the words in it, never a throw", async () => {
  const off = await readCanvasDesktop({
    machine: "mac-mini",
    chat: null,
    boards: fakeBoards(refused("unavailable", "This Studio does not serve canvas.list.")).api,
  });
  assert.deepEqual([off.boards, off.error], [null, "mac-mini is not offering its boards right now. Open SprintEngine Studio there and try again."]);
  const thrown = await readCanvasDesktop({
    machine: "mac-mini",
    chat: null,
    boards: { list: async () => { throw new Error("boom"); }, picture: async () => assert.fail() },
  });
  assert.equal(thrown.error, "mac-mini did not answer.");
});

test("a board the agent named opens as its picture: by id, or by name in the chat's project", () => {
  const chat = { deviceId: "dev_1", workspaceId: "ws-chat" };
  assert.equal(chatCanvasBoard(null, chat), null);
  assert.equal(chatCanvasBoard("  ", chat), null);
  const byId = chatCanvasBoard(ID, chat);
  assert.deepEqual(byId, { deviceId: "dev_1", id: ID, path: "arch.excalidraw", name: "arch", workspaceId: null, asker: "ws-chat" });
  assert.deepEqual(canvasPictureRequest(byId), { board: ID, workspaceId: "ws-chat" });
  const byName = chatCanvasBoard("export-flow", chat);
  assert.deepEqual(canvasPictureRequest(byName), { board: "export-flow", workspaceId: "ws-chat" });
  assert.equal(byName.name, "export-flow");
});

test("a row's picture is asked for by id with no project, or by path in the project it was listed under", () => {
  assert.deepEqual(canvasPictureRequest(canvasRowTarget("dev_1", board({ workspaceId: null }), null)), { board: ID, workspaceId: null });
  assert.deepEqual(canvasPictureRequest({ ...canvasRowTarget("dev_1", board(), null), id: null }), { board: "arch.excalidraw", workspaceId: "ws-2" });
});

test("a new chat starts beside the board, else in the asking chat's project, else under no project, else says why not", () => {
  const where = (overrides, noProject) =>
    canvasContinueTarget({ ...canvasRowTarget("dev_1", board(overrides), null), ...overrides }, { noProject, machine: "mac-mini" });
  assert.deepEqual(where({}, false), { kind: "workspace", workspaceId: "ws-2" });
  assert.deepEqual(where({ workspaceId: null, asker: "ws-chat" }, false), { kind: "workspace", workspaceId: "ws-chat" });
  assert.deepEqual(where({ workspaceId: null }, true), { kind: "no-project" });
  const refusal = where({ workspaceId: null }, false);
  assert.equal(refusal.kind, "refused");
  assert.match(refusal.message, /project is gone from mac-mini.*Update SprintEngine Studio there/);
});

test("a board survives the trip through a route's flat params, a removed project included", () => {
  const target = canvasRowTarget("dev_1", board({ project: null, workspaceId: null }), "ws-chat");
  assert.deepEqual(canvasTargetFromParams(canvasTargetParams(target)), target);
  const fromChat = chatCanvasBoard("export-flow", { deviceId: "dev_1", workspaceId: "ws-chat" });
  assert.deepEqual(canvasTargetFromParams(canvasTargetParams(fromChat)), fromChat);
  // A deep link leaves out what it does not know.
  assert.deepEqual(canvasTargetFromParams({ deviceId: "dev_1", name: "arch", path: "arch.excalidraw" }), {
    deviceId: "dev_1",
    id: null,
    path: "arch.excalidraw",
    name: "arch",
    workspaceId: null,
    asker: null,
  });
});
