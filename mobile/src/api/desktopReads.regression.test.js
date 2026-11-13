/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// What the phone reads of a desktop beside its chats, on the desktop's Studio
// protocol: the backlogs and shares where the grant reaches them, an item's
// status changed under a command id, and the desktop saying a backlog moved.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { readDesktopSnapshot, updateDesktopBacklogItem, watchDesktopBacklog } = require(
  path.join(buildRoot, "src/api/desktopReads.js"),
);
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

const backlog = {
  workspaceId: "backlog:ws_abc",
  workspacePath: "ws_abc",
  projectKey: "ws_abc",
  workspaceName: "app",
  updatedAt: "2026-11-12T10:00:00.000Z",
  items: [{ itemId: "i1", relativePath: "backlog/fix-login.md", title: "Fix login", status: "ready" }],
};
const share = { id: "serve:443", label: "localhost:5173", url: "https://mac-mini.example.ts.net/", localPort: 5173, machine: "mac-mini" };

let desktops = 0;
const target = () => ({ baseUrl: `http://mac-mini-${++desktops}:4100`, deviceToken: "mctn_example" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function desktopWith(scopes) {
  return fakeDesktopStudio({
    scopes,
    answer: (method, params) =>
      method === "backlog.list"
        ? { workspaces: [backlog] }
        : method === "shares.list"
          ? { shares: [share] }
          : method === "backlog.update"
            ? { item: { ...backlog.items[0], status: params.status } }
            : { error: { code: "unknown_method", message: "No method." } },
  });
}

test("a pairing that may operate the backlog reads it, the shares, and may change an item, once per command id", async () => {
  const desktop = desktopWith(["workspaces:read", "backlog:read", "backlog:operate"]);
  const options = { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket };
  const where = target();
  const read = await readDesktopSnapshot(where, options);
  assert.ok(read.ok);
  assert.deepEqual(read.data.backlog, [backlog]);
  assert.deepEqual(read.data.webTargets, [share]);
  assert.equal(read.data.canUpdateBacklog, true);

  const updated = await updateDesktopBacklogItem(
    where,
    { workspaceId: "backlog:ws_abc", relativePath: "backlog/fix-login.md", status: "idea" },
    options,
  );
  assert.ok(updated.ok);
  assert.equal(updated.data.item.status, "idea");
  const sent = desktop.requests.find((request) => request.method === "backlog.update");
  assert.match(sent.params.commandId, /^backlog-/u);
  assert.equal(sent.params.workspaceId, "backlog:ws_abc");
  closeDesktopStudios();
});

test("a read-only pairing reads what its grant reaches and is offered no change; one with no backlog reads none", async () => {
  const reader = desktopWith(["backlog:read"]);
  const read = await readDesktopSnapshot(target(), { fetchImpl: reader.fetchImpl, WebSocket: reader.WebSocket });
  assert.ok(read.ok);
  assert.equal(read.data.backlog.length, 1);
  assert.deepEqual(read.data.webTargets, [], "the shares are a workspace read it does not hold");
  assert.equal(read.data.canUpdateBacklog, false);
  assert.ok(!reader.requests.some((request) => request.method === "shares.list"), "not asked what it may not read");

  const chatsOnly = desktopWith(["conversation:read"]);
  const none = await readDesktopSnapshot(target(), { fetchImpl: chatsOnly.fetchImpl, WebSocket: chatsOnly.WebSocket });
  assert.ok(none.ok);
  assert.deepEqual(none.data.backlog, []);
  assert.equal(chatsOnly.requests.length, 0);
  closeDesktopStudios();
});

test("a refused change is said in the phone's words", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["backlog:read", "backlog:operate"],
    answer: () => ({ error: { code: "scope_required", message: "This pairing may not do that." } }),
  });
  const refused = await updateDesktopBacklogItem(
    target(),
    { workspaceId: "backlog:ws_abc", relativePath: "backlog/a.md", status: "idea" },
    { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "unauthorized");
  closeDesktopStudios();
});

test("the desktop says when a backlog moved, while the phone listens, and not after", async () => {
  const desktop = desktopWith(["backlog:read"]);
  const options = { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket };
  let heard = 0;
  const stop = watchDesktopBacklog(target(), () => (heard += 1), options);
  for (let tries = 0; tries < 50 && desktop.subscriptions.size === 0; tries++) await tick();
  assert.deepEqual([...desktop.subscriptions.values()], ["backlog.changed"]);
  desktop.push("backlog.changed", { workspaceIds: ["backlog:ws_abc"] });
  await tick();
  assert.equal(heard, 1);
  stop();
  await tick();
  assert.equal(desktop.subscriptions.size, 0, "let go of");
  closeDesktopStudios();
});

test("back from a dropped connection, the phone reads the backlog again: nothing said while it was down is replayed", async () => {
  const desktop = desktopWith(["backlog:read"]);
  const options = { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket };
  const where = target();
  let heard = 0;
  const stop = watchDesktopBacklog(where, () => (heard += 1), options);
  for (let tries = 0; tries < 50 && desktop.subscriptions.size === 0; tries++) await tick();
  const sockets = desktop.socketUrls.length;
  desktop.cut();
  for (let tries = 0; tries < 400 && heard === 0; tries++) await tick();
  assert.ok(desktop.socketUrls.length > sockets, "connected again");
  assert.equal(heard, 1, "told to read again once the connection is back");
  stop();
  desktop.cut();
  await tick();
  for (let tries = 0; tries < 100 && desktop.socketUrls.length === sockets + 1; tries++) await tick();
  await tick();
  assert.equal(heard, 1, "not after it is let go of");
  closeDesktopStudios();
});
