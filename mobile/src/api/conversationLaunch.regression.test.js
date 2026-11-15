const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildConversationCreateArgs,
  createConversation,
  findLaunchedThread,
  readConversationCreateFailure,
  threadFromLaunch,
} = require("../../.mobile-test-build/mobile/src/api/conversationLaunch.js");
const { closeDesktopStudios } = require("../../.mobile-test-build/mobile/src/api/desktopStudio.js");
const { fakeDesktopStudio } = require("../../.mobile-test-build/mobile/src/__verify__/fakeDesktopStudio.js");
const { StudioError } = require("../../.mobile-test-build/packages/client-runtime/src/rpc/errors.js");

const launched = {
  workspaceId: "workspace-1",
  agentId: "agent-claude-code-abc123",
  name: "Juniper",
  cli: "claude-code",
  providerId: "claude-agent",
  modelId: "default",
  sessionId: "session-1",
};

test("the arguments carry only what was chosen, trimmed", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: " workspace-1 " }), { workspaceId: "workspace-1" });
  assert.deepEqual(
    buildConversationCreateArgs({
      workspaceId: "workspace-1",
      prompt: "  Tidy the toast store.  ",
      cli: "claude-code",
      cliModel: "opus",
      permissionPreset: "bypass",
    }),
    { workspaceId: "workspace-1", prompt: "Tidy the toast store.", cli: "claude-code", model: "opus", permissionPreset: "bypass" },
  );
  assert.deepEqual(
    buildConversationCreateArgs({ workspaceId: "workspace-1", prompt: "   ", cli: "", cliModel: " ", permissionPreset: "none" }),
    { workspaceId: "workspace-1", permissionPreset: "none" },
  );
  // Manual and Auto are presets of their own on a desktop that runs them.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "auto" }), { workspaceId: "w", permissionPreset: "auto" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "manual" }), { workspaceId: "w", permissionPreset: "manual" });
  // A preset the desktop does not know is never sent; the desktop's own applies.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", permissionPreset: "yolo" }), { workspaceId: "w" });
  // New asks for a chat of its own; the workspace only names the folder.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true }), { workspaceId: "w", newChat: true });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: false }), { workspaceId: "w" });
});

test("a worktree rides only with a new chat, and an effort only when one was picked", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true, worktree: true }), {
    workspaceId: "w",
    newChat: true,
    worktree: true,
  });
  // The desktop refuses a worktree for a chat joining a workspace: never sent alone.
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", worktree: true }), { workspaceId: "w" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", newChat: true, worktree: false }), { workspaceId: "w", newChat: true });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", effort: " high " }), { workspaceId: "w", effort: "high" });
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "w", effort: "  " }), { workspaceId: "w" });
});

const machine = { deviceToken: "mctn_example", machineName: "mac-mini" };
let desktops = 0;
/** A paired desktop of its own for each case: the phone keeps one connection per desktop. */
const target = () => ({ ...machine, baseUrl: `http://mac-mini-${++desktops}:4100` });

test("a chat is started with conversation.create on the desktop's Studio, under one command id", async () => {
  const desktop = fakeDesktopStudio({ answer: () => ({ conversation: launched }) });
  const result = await createConversation(
    target(),
    { workspaceId: "workspace-1", prompt: "Go", cliModel: "opus", permissionPreset: "bypass", newChat: true, worktree: true },
    { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket, commandId: "chat-1" },
  );
  assert.deepEqual(result, { ok: true, conversation: launched });
  assert.deepEqual(desktop.requests, [
    {
      method: "conversation.create",
      params: {
        workspaceId: "workspace-1",
        prompt: "Go",
        model: "opus",
        permissionPreset: "bypass",
        newChat: true,
        worktree: true,
        commandId: "chat-1",
      },
    },
  ]);
  // The token buys a ticket and never rides the socket's URL; the socket names no origin.
  assert.equal(desktop.ticketHeaders[0].authorization, "Bearer mctn_example");
  assert.match(desktop.socketUrls[0], /^ws:\/\/mac-mini-\d+:4100\/tailnet\/v1\/studio\?ticket=mctk_1$/u);
  assert.doesNotMatch(desktop.socketUrls[0], /mctn_/u);
  closeDesktopStudios();
});

test("the desktop's refusals become plain sentences a person can act on", async () => {
  const read = async (code, message = "Studio's stable words.") => {
    const desktop = fakeDesktopStudio({ answer: () => ({ error: { code, message } }) });
    return createConversation(target(), { workspaceId: "w" }, { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  };
  assert.deepEqual(await read("scope_required"), {
    ok: false,
    failure: "refused",
    title: "This phone may not start chats on mac-mini.",
    message: "Pair again with chat control to start one here.",
  });
  assert.equal((await read("unknown_workspace")).title, "That project is no longer open on mac-mini.");
  assert.equal((await read("workspace_folder_missing")).title, "That project has no folder on mac-mini, so there is nowhere to start the chat.");
  assert.equal((await read("no_cli_selected")).message, "Pick one under Agent and model.");
  assert.equal((await read("cli_not_conversational")).title, "That CLI cannot run as a chat on mac-mini.");
  // Nothing was started; New reads the code to offer starting without a worktree.
  assert.deepEqual(await read("worktree_unavailable", "No worktree could be made."), {
    ok: false,
    failure: "refused",
    title: "mac-mini could not make a worktree for the chat.",
    message: "No worktree could be made.",
    code: "worktree_unavailable",
  });
  assert.equal((await read("unsupported_effort")).code, "unsupported_effort");
  assert.equal("code" in (await read("unknown_workspace")), false);
  assert.deepEqual(await read("conversation_start_failed", "The conversation could not be started."), {
    ok: false,
    failure: "refused",
    title: "mac-mini could not start the chat.",
    message: "The conversation could not be started.",
  });
  closeDesktopStudios();
});

test("an older desktop, an unpaired phone, and a desktop that does not answer", async () => {
  const older = fakeDesktopStudio({ answer: () => ({}), outdated: true });
  assert.deepEqual(await createConversation(target(), { workspaceId: "w" }, { fetchImpl: older.fetchImpl, WebSocket: older.WebSocket }), {
    ok: false,
    failure: "unsupported",
    title: "mac-mini cannot start chat agents yet.",
    message: "Update SprintEngine Studio there to start one from the phone.",
  });
  const unpaired = fakeDesktopStudio({ answer: () => ({}), ticketStatus: () => 401 });
  assert.equal(
    (await createConversation(target(), { workspaceId: "w" }, { fetchImpl: unpaired.fetchImpl, WebSocket: unpaired.WebSocket })).failure,
    "unpaired",
  );
  const offline = await createConversation(target(), { workspaceId: "w" }, {
    fetchImpl: async () => {
      throw new TypeError("Network request failed");
    },
  });
  assert.equal(offline.failure, "unavailable");
  assert.equal(offline.title, "mac-mini did not answer.");
  const slow = fakeDesktopStudio({ answer: () => new Promise(() => undefined) });
  const late = await createConversation(target(), { workspaceId: "w" }, { fetchImpl: slow.fetchImpl, WebSocket: slow.WebSocket, timeoutMs: 20 });
  assert.equal(late.title, "mac-mini took too long to start the chat.");
  const nameless = fakeDesktopStudio({ answer: () => ({ conversation: { ...launched, agentId: "" } }) });
  assert.equal(
    (await createConversation(target(), { workspaceId: "w" }, { fetchImpl: nameless.fetchImpl, WebSocket: nameless.WebSocket })).title,
    "mac-mini started the chat but did not say which one it is.",
  );
  closeDesktopStudios();
});

test("a failure is read from the runtime's error, whatever raised it", () => {
  assert.equal(readConversationCreateFailure(new StudioError("revoked", "x"), "mac-mini").failure, "unpaired");
  assert.equal(readConversationCreateFailure(new StudioError("peer_mismatch", "Paired as another device."), "mac-mini").title, "Paired as another device.");
  assert.equal(readConversationCreateFailure(new Error("boom"), " ").title, "The desktop did not answer.");
});

test("the thread to open: the listed one when it is there, else what the desktop said", () => {
  const listed = { ...threadFromLaunch(launched, { now: 1 }), title: "Listed", phase: "running", lastSeq: 3 };
  assert.equal(findLaunchedThread([listed], launched), listed);
  assert.equal(findLaunchedThread([{ ...listed, agentId: "other" }], launched), null);
  assert.deepEqual(threadFromLaunch(launched, { now: 1_790_000_000_000, permissionPreset: "bypass" }), {
    workspaceId: "workspace-1",
    agentId: "agent-claude-code-abc123",
    sessionId: "session-1",
    title: "Juniper",
    phase: "starting",
    updatedAt: 1_790_000_000_000,
    createdAt: 1_790_000_000_000,
    providerId: "claude-agent",
    modelId: "default",
    turnCount: 0,
    lastSeq: 0,
    permissionPreset: "bypass",
  });
  const bare = threadFromLaunch({ ...launched, name: "", sessionId: "" }, { now: 5 });
  assert.equal(bare.title, "Chat");
  assert.equal("sessionId" in bare, false);
  assert.equal("permissionPreset" in bare, false);
});

test("a first message with paragraph separators starts the chat with plain line breaks", () => {
  assert.deepEqual(buildConversationCreateArgs({ workspaceId: "workspace-1", prompt: " Plan it.\u2029Then build it.\r\n" }), {
    workspaceId: "workspace-1",
    prompt: "Plan it.\nThen build it.",
  });
});
