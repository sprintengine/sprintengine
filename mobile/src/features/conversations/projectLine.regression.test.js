/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// What a chat row's project line says, from what its desktop's
// `workspaces.list` says today: the project a pool slot or a nested worktree
// belongs to, one colour per project, and "No project" for a chat started
// without one, as the desktop's sidebar files the same chats.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build/mobile");
const { createTailnetWorkspacesApi, oneHuePerProject, PROJECTLESS_PROJECT_KEY } = require(
  path.join(buildRoot, "src/api/tailnetWorkspaces.js"),
);
const { buildChatRows, groupChatsByProject, pickableProjects } = require(
  path.join(buildRoot, "src/features/conversations/conversationListLogic.js"),
);

const NOW = 1_800_000_000_000;

const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));

let desktops = 0;
/** `listWorkspaces` against a desktop whose Studio answers `workspaces.list` with `rows`. */
async function listed(rows) {
  const desktop = fakeDesktopStudio({ answer: () => ({ workspaces: rows }) });
  try {
    const api = createTailnetWorkspacesApi(
      { baseUrl: `http://mac-mini-${++desktops}.tail1234.ts.net:8471`, deviceToken: "mctn_test" },
      { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket },
    );
    const answer = await api.listWorkspaces();
    assert.equal(answer.ok, true);
    assert.deepEqual(desktop.requests.map((request) => request.method), ["workspaces.list"]);
    return answer.data;
  } finally {
    closeDesktopStudios();
  }
}

test("New's reads go over the desktop's Studio: CLIs, a checkout, and a refusal in the phone's words", async () => {
  const desktop = fakeDesktopStudio({
    answer: (method, params) => {
      if (method === "providers.runtimes")
        return { clis: [{ id: "claude-code", agentSelectable: true, displayName: "Claude Code" }, { id: "other" }] };
      if (method === "workspaces.checkout")
        return params.workspaceId === "ws-1"
          ? { workspaceId: "ws-1", git: true, branch: "main", worktrees: [{ path: "/Users/dev/app", isMain: true, branch: "main" }] }
          : { error: { code: "scope_required", message: "This client's grant does not hold workspaces:read." } };
      return { error: { code: "unknown_method", message: "?" } };
    },
  });
  try {
    const api = createTailnetWorkspacesApi(
      { baseUrl: "http://build-box.tail1234.ts.net:8471", deviceToken: "mctn_test" },
      { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket },
    );
    const runtimes = await api.listCliRuntimes();
    assert.deepEqual(runtimes.ok && runtimes.data.map((cli) => cli.id), ["claude-code"]);
    const checkout = await api.readCheckout({ workspaceId: "ws-1", folderPath: "/Users/dev/app" });
    assert.deepEqual(checkout, { ok: true, data: { branch: "main", worktree: null, mainBranch: "main" } });
    const refused = await api.readCheckout({ workspaceId: "ws-2", folderPath: null });
    assert.equal(refused.ok, false);
    assert.equal(refused.errorCode, "unauthorized");
    // One connection for every read, opened with one ticket.
    assert.equal(desktop.socketUrls.length, 1);
  } finally {
    closeDesktopStudios();
  }
});

test("a project with no remote wears its checkout's colour on every worktree, as the desktop's sidebar paints it", async () => {
  // The desktop hashes each workspace's hue from its own folder when there is
  // no repository, so each slot arrives in a colour of its own.
  const workspaces = await listed([
    { id: "ws-04", name: "Chat", folderPath: "/Users/dev/.sprintengine-worktrees/demo-app/demo-app-04", projectHue: 40 },
    { id: "ws-07", name: "Chat", folderPath: "/Users/dev/.sprintengine-worktrees/demo-app/demo-app-07", projectHue: 200 },
    { id: "ws-main", name: "Chat", folderPath: "/Users/dev/demo-app", projectHue: 310 },
  ]);
  assert.deepEqual(
    workspaces.map((workspace) => [workspace.projectName, workspace.projectKey, workspace.projectHue]),
    [
      ["demo-app", "folder:/users/dev/demo-app", 310],
      ["demo-app", "folder:/users/dev/demo-app", 310],
      ["demo-app", "folder:/users/dev/demo-app", 310],
    ],
  );
  const rows = buildChatRows({
    deviceId: "dev_1",
    desktopName: "mac-mini",
    threads: workspaces.map((workspace, index) => ({
      workspaceId: workspace.workspaceId,
      agentId: `a${index}`,
      title: "Chat",
      phase: "completed",
      updatedAt: NOW - index,
      createdAt: NOW - 1000,
      providerId: "claude-agent",
      modelId: "default",
      turnCount: 1,
      lastSeq: 1,
    })),
    workspaces,
    lifecycle: false,
    canOperate: false,
  });
  const groups = groupChatsByProject(rows, NOW);
  assert.deepEqual(
    groups.map((group) => [group.projectName, group.projectHue, group.rows.length]),
    [["demo-app", 310, 3]],
  );
});

test("with no checkout listed, the first worktree's colour holds for the project", () => {
  const unified = oneHuePerProject([
    { projectKey: "folder:/u/app", projectHue: 40, worktree: "app-04" },
    { projectKey: "folder:/u/app", projectHue: 200, worktree: "app-07" },
    { projectKey: "repo:github.com/acme/web", projectHue: 90, worktree: null },
    { projectKey: null, projectHue: null, worktree: null },
  ]);
  assert.deepEqual(
    unified.map((workspace) => workspace.projectHue),
    [40, 40, 90, null],
  );
});

test("a chat started without a project is No project, in no colour, and New does not offer its folder", async () => {
  const workspaces = await listed([
    { id: "ws-a", name: "Hello", folderPath: "/Users/dev/.sprintengine/chats/2026-10-10-hello-ab12cd34", projectHue: 77 },
    { id: "ws-b", name: "Icons", folderPath: "/Users/dev/.sprintengine/chats/2026-10-11-icons-9f8e7d6c", projectHue: 123 },
    { id: "ws-c", name: "App", folderPath: "/Users/dev/demo-app", projectHue: 310 },
  ]);
  assert.deepEqual(
    workspaces.slice(0, 2).map((workspace) => [workspace.projectName, workspace.projectKey, workspace.projectHue, workspace.projectless]),
    [
      ["No project", PROJECTLESS_PROJECT_KEY, null, true],
      ["No project", PROJECTLESS_PROJECT_KEY, null, true],
    ],
  );
  const rows = buildChatRows({
    deviceId: "dev_1",
    desktopName: "mac-mini",
    threads: ["ws-a", "ws-b"].map((workspaceId, index) => ({
      workspaceId,
      agentId: `a${index}`,
      title: "Chat",
      phase: "completed",
      updatedAt: NOW - index,
      createdAt: NOW - 1000,
      providerId: "claude-agent",
      modelId: "default",
      turnCount: 1,
      lastSeq: 1,
    })),
    workspaces,
    lifecycle: false,
    canOperate: false,
  });
  assert.equal(rows.every((row) => row.projectless === true), true);
  const groups = groupChatsByProject(rows, NOW);
  assert.deepEqual(
    groups.map((group) => [group.projectName, group.projectless, group.rows.length]),
    [["No project", true, 2]],
  );
  assert.deepEqual(
    pickableProjects(workspaces).map((project) => project.projectName),
    ["demo-app"],
  );
});
