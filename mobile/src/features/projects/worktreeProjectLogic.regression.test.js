/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A chat in one of a project's worktrees files under the project, as the
// desktop's sidebar files it: by the recorded root where the desktop sends
// one, else by the container its worktrees are cut under.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  WORKTREE_CONTAINER_DIR,
  PROJECTLESS_CHATS_LABEL,
  projectFolderOf,
  projectlessScopeOf,
  repoRootFromWorktreePath,
  workspaceProject,
} = require(path.join(buildRoot, "src/features/projects/worktreeProjectLogic.js"));

test("a path in a worktree container names the checkout it was cut from", () => {
  assert.equal(WORKTREE_CONTAINER_DIR, ".sprintengine-worktrees");
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/.sprintengine-worktrees/multicode/pool-02"), "/Users/dev/code/multicode");
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/.sprintengine-worktrees/multicode/chat-ab12/"), "/Users/dev/code/multicode");
  // A slug may hold a "/": everything past the repo is the slug.
  assert.equal(repoRootFromWorktreePath("/u/.sprintengine-worktrees/app/agent/fix-1"), "/u/app");
  // A Windows path keeps its separators.
  assert.equal(repoRootFromWorktreePath("C:\\work\\.sprintengine-worktrees\\app\\pool-01"), "C:\\work\\app");
  // Not in a container, or no slug under the repo: not a worktree of anything.
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/multicode"), null);
  assert.equal(repoRootFromWorktreePath("/u/.sprintengine-worktrees/app"), null);
  assert.equal(repoRootFromWorktreePath(".sprintengine-worktrees/app/x"), null);
});

test("a worktree cut from a worktree files under the real project, and the desktop's record wins", () => {
  // pool-01's own container sits beside it: <parent>/.sprintengine-worktrees/pool-01.
  assert.equal(projectFolderOf("/u/.sprintengine-worktrees/app/.sprintengine-worktrees/pool-01/chat-1"), "/u/app");
  assert.equal(projectFolderOf("/elsewhere/feature-x", "/u/app"), "/u/app");
  assert.equal(projectFolderOf("/u/app"), "/u/app");
  assert.equal(projectFolderOf(null), null);
  assert.equal(projectFolderOf("  "), null);
});

test("a workspace says its project's folder and name, and its worktree's name when it is one", () => {
  assert.deepEqual(workspaceProject({ folderPath: "/Users/dev/code/.sprintengine-worktrees/multicode/pool-02" }), {
    projectFolder: "/Users/dev/code/multicode",
    projectName: "multicode",
    worktree: "pool-02",
    projectless: false,
  });
  assert.deepEqual(workspaceProject({ folderPath: "/Users/dev/code/multicode/" }), {
    projectFolder: "/Users/dev/code/multicode/",
    projectName: "multicode",
    worktree: null,
    projectless: false,
  });
  // A worktree made outside the container is known only by the desktop's record.
  assert.deepEqual(workspaceProject({ folderPath: "/tmp/wt/fix-login", recordedRoot: "/Users/dev/app" }), {
    projectFolder: "/Users/dev/app",
    projectName: "app",
    worktree: "fix-login",
    projectless: false,
  });
  assert.deepEqual(workspaceProject({ folderPath: null }), {
    projectFolder: null,
    projectName: null,
    worktree: null,
    projectless: false,
  });
});

// A pool slot is named after its project (`demo-app-04`), so it reads as one.
// Every way a desktop spells a worktree's path files it under its project, as
// the desktop's sidebar does for a paired machine's chats.
const SLOT = "/Users/dev/.sprintengine-worktrees/demo-app/demo-app-04";

test("a chat in a pool slot is named for its project, however the path is spelled", () => {
  const name = (folderPath) => workspaceProject({ folderPath }).projectName;
  assert.equal(name(SLOT), "demo-app");
  assert.equal(name(`${SLOT}/`), "demo-app", "a trailing separator changes nothing");
  assert.equal(name("C:\\dev\\.sprintengine-worktrees\\demo-app\\chat-k_iq"), "demo-app", "a Windows machine's path");
  assert.equal(workspaceProject({ folderPath: SLOT }).worktree, "demo-app-04");
  assert.equal(projectFolderOf(SLOT), "/Users/dev/demo-app");
});

test("a nested worktree is named for the project, not the worktree it was cut from", () => {
  const nested = "/Users/dev/.sprintengine-worktrees/demo-app/.sprintengine-worktrees/demo-app-04/chat-1";
  assert.equal(workspaceProject({ folderPath: nested }).projectName, "demo-app");
  assert.equal(projectFolderOf(nested), "/Users/dev/demo-app");
});

test("a worktree on an SSH machine files under that machine's checkout", () => {
  const slot = "ssh://build-box/home/dev/.sprintengine-worktrees/demo-app/demo-app-04";
  assert.deepEqual(workspaceProject({ folderPath: slot }), {
    projectFolder: "ssh://build-box/home/dev/demo-app",
    projectName: "demo-app",
    worktree: "demo-app-04",
    projectless: false,
  });
});

test("a folder outside the container keeps its own name, slot-like or not", () => {
  assert.equal(workspaceProject({ folderPath: "/Users/dev/worktrees/demo-app-04" }).projectName, "demo-app-04");
  assert.equal(workspaceProject({ folderPath: "/Users/dev/demo-app" }).projectName, "demo-app");
});

test("a chat started without a project files under No project, not under its own folder", () => {
  const chat = "/Users/dev/.sprintengine/chats/2026-10-10-hello-ab12cd34";
  assert.equal(PROJECTLESS_CHATS_LABEL, "No project");
  assert.equal(projectlessScopeOf(chat), "/Users/dev/.sprintengine/chats");
  assert.equal(projectlessScopeOf("/Users/dev/.sprintengine/chats/"), "/Users/dev/.sprintengine/chats");
  assert.equal(projectlessScopeOf("C:\\Users\\dev\\.sprintengine\\chats\\2026-10-10-hi-1a2b"), "C:\\Users\\dev\\.sprintengine\\chats");
  // Only a direct child: a folder the agent made in its chat's folder is that chat's work.
  assert.equal(projectlessScopeOf(`${chat}/web`), null);
  assert.equal(projectlessScopeOf(".sprintengine/chats/x"), null, "a relative path only looks like the root");
  assert.equal(projectlessScopeOf("/Users/dev/code/chats/x"), null);
  assert.deepEqual(workspaceProject({ folderPath: chat }), {
    projectFolder: "/Users/dev/.sprintengine/chats",
    projectName: "No project",
    worktree: null,
    projectless: true,
  });
});
