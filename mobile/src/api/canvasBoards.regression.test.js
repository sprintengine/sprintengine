/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A paired desktop's Canvas boards over the gateway: what the phone sends to
// `canvas.list` and `canvas.screenshot`, and how it reads what comes back.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  CANVAS_PICTURE_MAX_EDGE,
  buildCanvasScreenshotArgs,
  canvasBoardName,
  createCanvasBoardsApi,
  isCanvasBoardId,
  readCanvasBoards,
  readCanvasPicture,
} = require(path.join(buildRoot, "src/api/canvasBoards.js"));

const STORE = `ws_${"a".repeat(24)}`;

/** Runs `run` against a gateway that answers each call with `answer(name, args)`; returns the calls made. */
async function withGateway(answer, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, name: body.params.name, args: body.params.arguments });
    const reply = answer(body.params.name, body.params.arguments);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...reply }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await run(createCanvasBoardsApi({ baseUrl: "http://mac-mini.tail1234.ts.net:8471", deviceToken: "mctn_test" }));
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

test("a machine-wide answer is read row by row, with each board's project, id and workspace", () => {
  const read = readCanvasBoards(
    {
      scope: "machine",
      boards: [
        { id: `canvas://${STORE}/arch.excalidraw`, path: "arch.excalidraw", name: "arch", project: "atlas", here: true, workspaceId: "ws-2", elementCount: 3, modifiedAt: "2026-11-07T10:00:00.000Z" },
        { id: `canvas://${STORE}/orphan.excalidraw`, path: "orphan.excalidraw", name: "orphan", project: null, workspaceId: null, elementCount: 0, modifiedAt: "not a date" },
        { path: "" },
        "nonsense",
        { path: "diagrams/flow.excalidraw" },
      ],
      note: "These are the 200 most recently changed of 240 boards on this machine.",
    },
    null,
  );
  assert.deepEqual(read.boards[0], {
    id: `canvas://${STORE}/arch.excalidraw`,
    path: "arch.excalidraw",
    name: "arch",
    project: "atlas",
    workspaceId: "ws-2",
    here: true,
    modifiedAt: Date.parse("2026-11-07T10:00:00.000Z"),
    elementCount: 3,
  });
  assert.deepEqual(
    read.boards.slice(1).map((board) => [board.name, board.project, board.workspaceId, board.modifiedAt, board.elementCount, board.id]),
    [
      ["orphan", null, null, 0, 0, `canvas://${STORE}/orphan.excalidraw`],
      ["flow", null, null, 0, -1, null],
    ],
  );
  assert.match(read.note, /200 most recently changed/);
});

test("one project's answer files every row under the project it was asked about", () => {
  const read = readCanvasBoards({ boards: [{ path: "arch.excalidraw", name: "arch", elementCount: 2 }] }, { workspaceId: "ws-1", name: "atlas" });
  assert.deepEqual(read.boards.map((board) => [board.project, board.workspaceId, board.here, board.id]), [["atlas", "ws-1", true, null]]);
  assert.equal(read.note, null);
  assert.deepEqual(readCanvasBoards(null, null), { boards: [], note: null });
});

test("a picture is read from the image block, and nothing but a PNG or a JPEG is drawn", () => {
  const answer = (mimeType, data = "iVBORw0") => ({
    ok: true,
    structured: { width: 720, height: 420 },
    content: [{ type: "text", text: "arch: 720x420" }, { type: "image", mimeType, data }],
  });
  assert.deepEqual(readCanvasPicture(answer("image/png")), { uri: "data:image/png;base64,iVBORw0", width: 720, height: 420 });
  assert.equal(readCanvasPicture(answer("image/jpeg")).uri.startsWith("data:image/jpeg;base64,"), true);
  assert.equal(readCanvasPicture(answer("image/svg+xml")), null);
  assert.equal(readCanvasPicture(answer("image/png", "")), null);
  assert.equal(readCanvasPicture({ ok: true, structured: {}, content: [] }), null);
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
  assert.deepEqual(buildCanvasScreenshotArgs({ board: "arch", workspaceId: "ws-1", dark: true }), {
    board: "arch",
    workspaceId: "ws-1",
    maxEdge: 1600,
    dark: true,
  });
  assert.deepEqual(buildCanvasScreenshotArgs({ board: `canvas://${STORE}/a.excalidraw`, workspaceId: null, dark: false }), {
    board: `canvas://${STORE}/a.excalidraw`,
    maxEdge: 1600,
    dark: false,
  });
});

test("the phone lists a machine with scope machine and needs no workspace, and one project without a scope", async () => {
  const calls = await withGateway(
    () => ({ result: { structuredContent: { boards: [{ path: "arch.excalidraw", name: "arch" }] } } }),
    async (api) => {
      const all = await api.listMachine(null);
      assert.equal(all.ok, true);
      assert.equal(all.data.boards[0].project, null);
      await api.listMachine("ws-chat");
      const one = await api.listProject({ workspaceId: "ws-1", name: "atlas" });
      assert.equal(one.data.boards[0].project, "atlas");
    },
  );
  assert.deepEqual(
    calls.map((call) => [call.name, call.args]),
    [
      ["canvas.list", { scope: "machine" }],
      ["canvas.list", { scope: "machine", workspaceId: "ws-chat" }],
      ["canvas.list", { workspaceId: "ws-1" }],
    ],
  );
  assert.equal(calls[0].url, "http://mac-mini.tail1234.ts.net:8471/tailnet/v1/mcp");
  assert.equal(calls[0].auth, "Bearer mctn_test");
});

test("a machine with no canvas tools, a refusal, and an answer with no picture each keep what a person can act on", async () => {
  await withGateway(
    (name, args) => {
      if (name === "canvas.list") return { error: { code: -32601, message: "Unknown tool: canvas.list" } };
      if (args.board === "gone")
        return { result: { isError: true, structuredContent: { ok: false, error: { code: "not_found", message: "There is no board at gone.excalidraw yet." } } } };
      if (args.board === "scoped")
        return { result: { isError: true, structuredContent: { ok: false, error: { code: "tailnet_scope_required", message: "Needs workspace:read." } } } };
      return { result: { structuredContent: { ok: true, width: 1, height: 1 }, content: [{ type: "text", text: "no picture" }] } };
    },
    async (api) => {
      const listed = await api.listMachine(null);
      assert.deepEqual([listed.ok, listed.code], [false, "unknown_tool"]);
      const gone = await api.picture({ board: "gone", workspaceId: "ws-1", dark: false });
      assert.deepEqual([gone.ok, gone.code, gone.message], [false, "not_found", "There is no board at gone.excalidraw yet."]);
      const scoped = await api.picture({ board: "scoped", workspaceId: "ws-1", dark: false });
      assert.deepEqual([scoped.ok, scoped.errorCode], [false, "unauthorized"]);
      const blank = await api.picture({ board: "arch", workspaceId: "ws-1", dark: false });
      assert.deepEqual([blank.ok, blank.code], [false, "no_picture"]);
    },
  );
});
