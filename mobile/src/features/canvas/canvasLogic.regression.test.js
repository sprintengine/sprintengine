/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The phone's Canvases: how each desktop is asked for its boards, what is said
// when the answer is not the whole machine's, what a picture is asked for,
// and where Continue in a new chat starts, in the desktop's own words.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  CANVAS_DELETED_PROJECT_LABEL,
  canvasBoardMeta,
  canvasContinueMessage,
  canvasContinuePrompt,
  canvasContinueTarget,
  canvasListMode,
  canvasListModeNote,
  canvasPictureRequest,
  canvasProjectLabel,
  canvasProjectsToAsk,
  canvasRefusalWords,
  canvasRowTarget,
  canvasTargetFromParams,
  canvasTargetParams,
  chatCanvasBoard,
  mergeCanvasLists,
  readCanvasDesktop,
} = require(path.join(buildRoot, "src/features/canvas/canvasLogic.js"));

const STORE = `ws_${"a".repeat(24)}`;
const ID = `canvas://${STORE}/arch.excalidraw`;
const CURRENT = { tailnetCapabilities: ["conversations", "canvas-machine-boards"] };
const OLDER = { tailnetCapabilities: ["conversations"] };

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

const fakeBoards = (answers) => {
  const calls = [];
  return {
    calls,
    api: {
      async listMachine(asker) {
        calls.push(["machine", asker]);
        return answers.machine;
      },
      async listProject(project) {
        calls.push(["project", project.workspaceId, project.name]);
        return answers.project(project);
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
  // A row from an older desktop has no id, and names its board by path.
  assert.match(canvasContinueMessage(canvasRowTarget("dev_1", board({ id: null, path: "diagrams/flow.excalidraw", name: "flow" }), null)), /Pass diagrams\/flow\.excalidraw as/);
});

test("a removed project reads as the desktop says it", () => {
  assert.equal(CANVAS_DELETED_PROJECT_LABEL, "Deleted project");
  assert.equal(canvasProjectLabel(null), "Deleted project");
  assert.equal(canvasBoardMeta(board({ project: null, elementCount: 0 })), "Deleted project · Empty");
  assert.equal(canvasBoardMeta(board({ elementCount: 1 })), "atlas · 1 element");
  assert.equal(canvasBoardMeta(board({ elementCount: -1 })), "atlas");
});

test("a desktop is asked for every board where it says it can, else one project at a time, and the list says so", () => {
  assert.equal(canvasListMode(CURRENT, null), "machine");
  assert.equal(canvasListMode(CURRENT, { workspaceId: "ws-1" }), "machine");
  assert.equal(canvasListMode(OLDER, { workspaceId: "ws-1" }), "project");
  assert.equal(canvasListMode(OLDER, null), "projects");
  assert.equal(canvasListMode({}, null), "projects", "a pairing that declared nothing reads as older");
  assert.equal(canvasListModeNote("machine", "mac-mini"), null);
  assert.equal(
    canvasListModeNote("project", "mac-mini"),
    "mac-mini lists only this project's boards. Update SprintEngine Studio there to see all of them.",
  );
  assert.match(canvasListModeNote("projects", "mac-mini"), /one project at a time.*none from a removed project.*Update SprintEngine Studio there/);
});

test("a machine offering no canvas tools says to open Studio there, never Unknown tool", () => {
  assert.equal(
    canvasRefusalWords("mac-mini", refused("unknown_tool", "Unknown tool: canvas.list"), "list"),
    "mac-mini is not offering its boards right now. Open SprintEngine Studio there and try again.",
  );
  assert.match(canvasRefusalWords("mac-mini", refused(null, "nope", "unauthorized"), "list"), /may not read mac-mini's projects/);
  assert.equal(canvasRefusalWords("mac-mini", refused("no_picture"), "picture"), "mac-mini sent no picture of this board.");
  assert.equal(canvasRefusalWords("mac-mini", refused("canvas_module_disabled", "The Canvas module is disabled."), "list"), "The Canvas module is disabled.");
  assert.equal(canvasRefusalWords("mac-mini", refused(null, ""), "list"), "mac-mini did not list its boards.");
});

test("an older desktop is asked once per project, its checkout over its worktrees, and never about No project", () => {
  assert.deepEqual(
    canvasProjectsToAsk([
      { workspaceId: "ws-slot", projectName: "atlas", projectKey: "repo:x/atlas", worktree: "pool-01" },
      { workspaceId: "ws-main", projectName: "atlas", projectKey: "repo:x/atlas", worktree: null },
      { workspaceId: "ws-slot2", projectName: "atlas", projectKey: "repo:x/atlas", worktree: "pool-02" },
      { workspaceId: "ws-web", projectName: "web", projectKey: "folder:/u/web", worktree: "pool-01" },
      { workspaceId: "ws-chat", projectName: "No project", projectKey: "noproject:", worktree: null, projectless: true },
      { workspaceId: "ws-bare", projectName: "Chat", projectKey: null, worktree: null },
    ]),
    [
      { workspaceId: "ws-main", name: "atlas" },
      { workspaceId: "ws-web", name: "web" },
    ],
  );
});

test("several projects' lists are one, newest first, each board once", () => {
  const merged = mergeCanvasLists([
    [board({ id: null, path: "a.excalidraw", name: "a", workspaceId: "ws-1", modifiedAt: 5 })],
    [
      board({ id: null, path: "b.excalidraw", name: "b", workspaceId: "ws-2", modifiedAt: 9 }),
      board({ id: null, path: "a.excalidraw", name: "a", workspaceId: "ws-1", modifiedAt: 5 }),
    ],
  ]);
  assert.deepEqual(merged.map((entry) => entry.name), ["b", "a"]);
});

test("a current desktop is read in one call, under the asking chat where there is one", async () => {
  const fake = fakeBoards({ machine: ok([board()], "capped") });
  const read = await readCanvasDesktop({
    machine: "mac-mini",
    session: CURRENT,
    chat: { workspaceId: "ws-chat", projectName: "atlas" },
    boards: fake.api,
    workspaces: { listWorkspaces: async () => assert.fail("not asked") },
  });
  assert.deepEqual(fake.calls, [["machine", "ws-chat"]]);
  assert.deepEqual([read.boards.length, read.notes, read.error], [1, ["capped"], null]);
});

test("an older desktop asked from a chat lists that project and says it is that project's alone", async () => {
  const fake = fakeBoards({ project: () => ok([board({ id: null })]) });
  const read = await readCanvasDesktop({
    machine: "mac-mini",
    session: OLDER,
    chat: { workspaceId: "ws-chat", projectName: "atlas" },
    boards: fake.api,
    workspaces: { listWorkspaces: async () => assert.fail("not asked") },
  });
  assert.deepEqual(fake.calls, [["project", "ws-chat", "atlas"]]);
  assert.deepEqual(read.notes, ["mac-mini lists only this project's boards. Update SprintEngine Studio there to see all of them."]);
});

test("an older desktop asked from home lists each open project, and names the ones that did not answer", async () => {
  const fake = fakeBoards({
    project: (project) =>
      project.workspaceId === "ws-web" ? refused("canvas_module_disabled", "off") : ok([board({ id: null, workspaceId: project.workspaceId, project: project.name })]),
  });
  const read = await readCanvasDesktop({
    machine: "mac-mini",
    session: OLDER,
    chat: null,
    boards: fake.api,
    workspaces: {
      listWorkspaces: async () => ({
        ok: true,
        data: [
          { workspaceId: "ws-atlas", projectName: "atlas", projectKey: "repo:x/atlas", worktree: null },
          { workspaceId: "ws-web", projectName: "web", projectKey: "repo:x/web", worktree: null },
        ],
      }),
    },
  });
  assert.deepEqual(read.boards.map((entry) => entry.project), ["atlas"]);
  assert.equal(read.notes.length, 2);
  assert.match(read.notes[0], /one project at a time/);
  assert.equal(read.notes[1], "web did not list its boards.");
});

test("an older desktop with no canvas tools stops at the first answer and says to open Studio", async () => {
  const fake = fakeBoards({ project: () => refused("unknown_tool", "Unknown tool: canvas.list") });
  const read = await readCanvasDesktop({
    machine: "mac-mini",
    session: OLDER,
    chat: null,
    boards: fake.api,
    workspaces: {
      listWorkspaces: async () => ({
        ok: true,
        data: Array.from({ length: 9 }, (_, index) => ({ workspaceId: `ws-${index}`, projectName: `p${index}`, projectKey: `repo:x/p${index}`, worktree: null })),
      }),
    },
  });
  assert.equal(fake.calls.length, 4, "one batch, not every project");
  assert.deepEqual([read.boards, read.error], [null, "mac-mini is not offering its boards right now. Open SprintEngine Studio there and try again."]);
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
  assert.deepEqual(canvasPictureRequest(canvasRowTarget("dev_1", board({ id: null }), null)), { board: "arch.excalidraw", workspaceId: "ws-2" });
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
