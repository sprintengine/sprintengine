/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// What a chat row's project line says, from what its desktop's
// `workspace.list` says today: the project a pool slot or a nested worktree
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

/** `listWorkspaces` against a desktop answering `rows`, through a stubbed fetch. */
async function listed(rows) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { structuredContent: { workspaces: rows } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const api = createTailnetWorkspacesApi({ baseUrl: "http://mac-mini.tail1234.ts.net:8471", deviceToken: "mctn_test" });
    const answer = await api.listWorkspaces();
    assert.equal(answer.ok, true);
    return answer.data;
  } finally {
    globalThis.fetch = original;
  }
}

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
