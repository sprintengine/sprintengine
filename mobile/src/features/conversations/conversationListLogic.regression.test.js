const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CHAT_DATE_SECTION_LABEL,
  CHAT_EARLIER_AFTER_MS,
  chatCliMark,
  chatDateSectionOf,
  chatDateSections,
  canReadWorkspaces,
  canStartChats,
  chatLaunchAvailability,
  chatOpenedKey,
  chatRowState,
  chatActivity,
  chatHasUnseenTurn,
  chatModelName,
  chatRecencyAt,
  chatRestingAt,
  chatSeenAt,
  chatTurnEndedAt,
  buildChatRows,
  chatRowTitle,
  chatWorkspaceKey,
  countWorkspaceChats,
  groupChatsByProject,
  chatSections,
  cliForChatProvider,
  formatChatElapsed,
  formatChatSettledAt,
  matchesChatSearch,
  pickableProjects,
  resolveChatLink,
  routesInPlaceOfTop,
} = require("../../../.mobile-test-build/mobile/src/features/conversations/conversationListLogic.js");

// A fixed Tuesday at noon, local time, so weekday readings do not depend on
// the day the suite runs.
const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Every Studio lists a chat's clocks: when the person last wrote in it and when
// its last turn ended. A case that names only `updatedAt` means all three.
function thread(overrides = {}) {
  const at = overrides.updatedAt;
  const clocks = at !== undefined && !("lastUserMessageAt" in overrides) && !("lastTurnEndedAt" in overrides);
  return {
    ...(clocks ? { lastUserMessageAt: at, lastTurnEndedAt: at } : {}),
    workspaceId: "workspace",
    agentId: "agent",
    title: "Remote conversation launch",
    phase: "completed",
    updatedAt: NOW - 2 * MIN,
    createdAt: NOW - HOUR,
    providerId: "claude-agent",
    modelId: "default",
    turnCount: 1,
    lastSeq: 4,
    ...overrides,
  };
}

function row(overrides = {}, where = {}) {
  return { deviceId: "mac-mini-id", desktopName: "mac-mini", projectName: "multicode", ...where, thread: thread(overrides) };
}

test("the CLI mark follows the catalog's CLI first, then the provider", () => {
  assert.deepEqual(chatCliMark(thread()), { kind: "claude", cli: "claude-code", label: "Claude Code" });
  assert.deepEqual(
    chatCliMark(thread({ providerId: "other-agent", models: { cli: "claude-code", cliLabel: "Claude", liveModelSwitch: true, options: [] } })),
    { kind: "claude", cli: "claude-code", label: "Claude" },
  );
  // Any other CLI is a neutral tile with the prompt; its name is the label.
  assert.deepEqual(chatCliMark(thread({ providerId: "shell-agent" })), { kind: "cli", cli: "shell", label: "Shell", mark: ">_" });
  assert.deepEqual(
    chatCliMark(thread({ providerId: "x", models: { cli: "some-cli", cliLabel: "", liveModelSwitch: false, options: [] } })),
    { kind: "cli", cli: "some-cli", label: "Some Cli", mark: ">_" },
  );
  // A provider that is not a CLI keeps a chat mark of its own initial.
  assert.deepEqual(chatCliMark(thread({ providerId: "anthropic" })), { kind: "chat", label: "Chat", mark: "A" });
  assert.deepEqual(chatCliMark(thread({ providerId: "" })), { kind: "chat", label: "Chat", mark: "C" });
});

test("the provider table names Claude's CLI and reads the rest by the -agent rule", () => {
  assert.equal(cliForChatProvider("claude-agent"), "claude-code");
  assert.equal(cliForChatProvider("shell-agent"), "shell");
  assert.equal(cliForChatProvider("api-key-provider"), null);
  assert.equal(cliForChatProvider(""), null);
  assert.equal(cliForChatProvider(undefined), null);
});

test("a row leads with the title summary, and names the agent only in a shared workspace", () => {
  const alone = { ...row({ title: "Dara Clune" }), workspaceTitle: "WSL agent access issue", workspaceChats: 1 };
  assert.deepEqual(chatRowTitle(alone), { title: "WSL agent access issue", agent: null });
  const shared = { ...alone, workspaceChats: 2 };
  assert.deepEqual(chatRowTitle(shared), { title: "WSL agent access issue", agent: "Dara Clune" });
  // No workspace list: the thread's own title is the best there is.
  assert.deepEqual(chatRowTitle({ ...alone, workspaceTitle: null }), { title: "Dara Clune", agent: null });
  // An agent named like its workspace is not repeated.
  assert.deepEqual(chatRowTitle({ ...shared, thread: thread({ title: "WSL agent access issue" }) }), { title: "WSL agent access issue", agent: null });
});

test("the last line says what the chat is doing, and nothing while it rests", () => {
  assert.deepEqual(chatActivity(thread({ phase: "running" })), { tone: "working", text: "Thinking" });
  assert.deepEqual(chatActivity(thread({ phase: "starting" })), { tone: "working", text: "Starting" });
  assert.deepEqual(chatActivity(thread({ phase: "waiting_for_approval" })), { tone: "warn", text: "Needs approval" });
  assert.deepEqual(chatActivity(thread({ phase: "waiting_for_input" })), { tone: "warn", text: "Asked a question" });
  assert.deepEqual(chatActivity(thread({ phase: "failed" })), { tone: "failed", text: "Failed" });
  assert.deepEqual(chatActivity(thread({ phase: "completed" })), { tone: "quiet", text: "" });
});

test("the model pill names the model, not the CLI the logo already shows", () => {
  const models = { cli: "claude-code", cliLabel: "Claude Code", liveModelSwitch: true, options: [{ id: "opus", label: "Opus 5.5" }] };
  assert.equal(chatModelName(thread({ modelId: "opus", models })), "Opus 5.5");
  assert.equal(chatModelName(thread({ models })), "Default");
  assert.equal(chatModelName(thread({ modelId: "sonnet-x" })), "sonnet-x");
});

test("the project view groups by project, the one last written in first; waiting on you lifts nothing", () => {
  const at = (overrides, where) => ({ ...row(overrides), ...where });
  const rows = [
    at({ agentId: "a", updatedAt: NOW - 5 * MIN }, { projectKey: "repo:x/wingfoil", projectName: "wingfoil", projectHue: 40 }),
    at({ agentId: "b", updatedAt: NOW - 1 * MIN }, { projectKey: "repo:x/multicode", projectName: "multicode", projectHue: null }),
    at({ agentId: "c", updatedAt: NOW - 3 * HOUR, phase: "waiting_for_input" }, { projectKey: "repo:x/acme-app", projectName: "acme-app" }),
    at({ agentId: "d", updatedAt: NOW - 2 * MIN }, { projectKey: "repo:x/multicode", projectName: "multicode", projectHue: 262 }),
  ];
  const groups = groupChatsByProject(rows, NOW);
  // The project whose chat waits on you stays where its last message puts it.
  assert.deepEqual(groups.map((group) => group.projectName), ["multicode", "wingfoil", "acme-app"]);
  assert.deepEqual(groups[0].rows.map((r) => r.thread.agentId), ["b", "d"]);
  // A hue any chat in the project carries colours the whole group.
  assert.equal(groups[0].projectHue, 262);
  // Workspaces are counted per desktop and workspace, which is what names the agent.
  const counts = countWorkspaceChats([at({ agentId: "x" }, {}), at({ agentId: "y" }, {})]);
  assert.equal(counts.get(chatWorkspaceKey(rows[0])), 2);
});

test("elapsed and settled times read as the mockup's", () => {
  assert.equal(formatChatElapsed(NOW, NOW), "0s");
  assert.equal(formatChatElapsed(NOW + 5_000, NOW), "0s", "a clock ahead of ours never reads negative");
  assert.equal(formatChatElapsed(NOW - 59_999, NOW), "59s");
  assert.equal(formatChatElapsed(NOW - (HOUR + 4 * MIN), NOW), "1h 4m");
  assert.equal(formatChatSettledAt(NOW - 30_000, NOW), "now");
  assert.equal(formatChatSettledAt(NOW - 59 * MIN, NOW), "59m");
  assert.equal(formatChatSettledAt(NOW - 23 * HOUR, NOW), "23h");
  assert.equal(formatChatSettledAt(NOW - 3 * DAY, NOW), "Sat");
  assert.equal(formatChatSettledAt(NOW - 17 * DAY, NOW), "12 Sep");
});

test("a chat that finished since it was opened wears the green, but only within the day", () => {
  const done = thread({ phase: "completed", updatedAt: NOW - 5 * MIN });
  assert.equal(chatRowState(done, { now: NOW, openedAt: null }), "finished");
  assert.equal(chatRowState(done, { now: NOW, openedAt: NOW - 10 * MIN }), "finished");
  assert.equal(chatRowState(done, { now: NOW, openedAt: NOW - 5 * MIN }), "idle", "watched it end");
  assert.equal(chatRowState(done, { now: NOW, openedAt: NOW - MIN }), "idle");
  assert.equal(chatRowState(thread({ updatedAt: NOW - 2 * DAY }), { now: NOW, openedAt: null }), "idle", "history, not news");
  assert.equal(chatRowState(thread({ phase: "waiting_for_input" }), { now: NOW }), "needs-input");
  assert.equal(chatRowState(thread({ phase: "running" }), { now: NOW }), "working");
  assert.equal(chatRowState(thread({ phase: "failed" }), { now: NOW }), "failed");
  assert.equal(chatRowState(thread({ phase: "idle" }), { now: NOW }), "idle");
});

test("sections: newest first, a waiting chat stays put, and a chat at rest over a day goes under Earlier", () => {
  const rows = [
    row({ agentId: "done", phase: "completed", updatedAt: NOW - 2 * MIN }),
    row({ agentId: "old", phase: "completed", updatedAt: NOW - 3 * DAY }),
    row({ agentId: "failed-old", phase: "failed", updatedAt: NOW - 2 * DAY }),
    row({ agentId: "working", phase: "running", updatedAt: NOW - MIN }),
    row({ agentId: "waiting", phase: "waiting_for_approval", updatedAt: NOW - 3 * HOUR }),
    // Waiting for days is still waiting: it never goes under Earlier.
    row({ agentId: "stale-waiting", phase: "waiting_for_input", updatedAt: NOW - 4 * DAY }),
    row({ agentId: "edge", phase: "completed", updatedAt: NOW - CHAT_EARLIER_AFTER_MS }),
  ];
  const { recent, earlier } = chatSections(rows, NOW);
  // No lifting by state: a waiting chat sits where
  // its last message puts it, and one waiting for days stays in view at the end.
  assert.deepEqual(
    recent.map((item) => item.thread.agentId),
    ["working", "done", "waiting", "edge", "stale-waiting"],
  );
  assert.deepEqual(earlier.map((item) => item.thread.agentId), ["failed-old", "old"]);
});

// The Date grouping reads local calendar days, so its clocks are local too:
// ten past midnight on Tuesday 29 September 2026.
const AFTER_MIDNIGHT = new Date(2026, 8, 29, 0, 10).getTime();
const localAt = (month, day, hour = 0, minute = 0, ms = 0) => new Date(2026, month, day, hour, minute, 0, ms).getTime();

test("by date: a chat sits in the local calendar day it was last written in, not the last 24 hours", () => {
  // 23:50 last night is Yesterday at 00:10, twenty minutes later.
  assert.equal(chatDateSectionOf(localAt(8, 28, 23, 50), AFTER_MIDNIGHT), "yesterday");
  assert.equal(chatDateSectionOf(localAt(8, 28, 23, 59, 59_999), AFTER_MIDNIGHT), "yesterday");
  assert.equal(chatDateSectionOf(localAt(8, 29), AFTER_MIDNIGHT), "today", "midnight itself starts today");
  assert.equal(chatDateSectionOf(localAt(8, 28), AFTER_MIDNIGHT), "yesterday", "yesterday's own midnight");
  assert.equal(chatDateSectionOf(localAt(8, 27, 23, 59, 59_999), AFTER_MIDNIGHT), "week");
  // The week is the seven days before today, from that day's start.
  assert.equal(chatDateSectionOf(localAt(8, 22), AFTER_MIDNIGHT), "week");
  assert.equal(chatDateSectionOf(localAt(8, 22) - 1, AFTER_MIDNIGHT), "month");
  // The month is the thirty days before today: 30 August, from its start.
  assert.equal(chatDateSectionOf(localAt(7, 30), AFTER_MIDNIGHT), "month");
  assert.equal(chatDateSectionOf(localAt(7, 30) - 1, AFTER_MIDNIGHT), "older");
  // The same chat at noon: still a calendar day, whatever the hour.
  assert.equal(chatDateSectionOf(localAt(8, 28, 0, 5), NOW), "yesterday");
  assert.equal(chatDateSectionOf(localAt(8, 29, 0, 5), NOW), "today");
});

test("by date: a stamp ahead of the phone's clock is today, and a missing one is Older", () => {
  assert.equal(chatDateSectionOf(AFTER_MIDNIGHT + 3 * DAY, AFTER_MIDNIGHT), "today");
  assert.equal(chatDateSectionOf(0, AFTER_MIDNIGHT), "older");
  assert.equal(chatDateSectionOf(Number.NaN, AFTER_MIDNIGHT), "older");
  assert.equal(chatDateSectionOf(-5, AFTER_MIDNIGHT), "older");
  // A chat with no clock at all, from an older desktop.
  const unstamped = row({ agentId: "unstamped", updatedAt: 0 });
  assert.deepEqual(
    chatDateSections([unstamped], AFTER_MIDNIGHT).map((group) => group.section),
    ["older"],
  );
});

test("by date: sections run newest first under their headings, and an empty one is left out", () => {
  const lifecycle = { lifecycle: true };
  const rows = [
    row({ agentId: "today", lastUserMessageAt: localAt(8, 29, 0, 2) }, lifecycle),
    row({ agentId: "late-last-night", lastUserMessageAt: localAt(8, 28, 23, 50) }, lifecycle),
    row({ agentId: "last-month", lastUserMessageAt: localAt(8, 1, 9) }, lifecycle),
    // Waiting for days is still sectioned by its last message: no lifting.
    row({ agentId: "waiting", phase: "waiting_for_input", lastUserMessageAt: localAt(5, 1) }, lifecycle),
  ];
  const groups = chatDateSections(rows, AFTER_MIDNIGHT);
  assert.deepEqual(
    groups.map((group) => [group.title, group.rows.map((item) => item.thread.agentId)]),
    [
      ["Today", ["today"]],
      ["Yesterday", ["late-last-night"]],
      ["Previous 30 days", ["last-month"]],
      ["Older", ["waiting"]],
    ],
  );
  assert.deepEqual(Object.values(CHAT_DATE_SECTION_LABEL), ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]);
  assert.deepEqual(chatDateSections([], AFTER_MIDNIGHT), []);
});

test("by date: rows keep the order they were given within a section, even out of time order", () => {
  const lifecycle = { lifecycle: true };
  const rows = [
    row({ agentId: "week-early", lastUserMessageAt: localAt(8, 23, 8) }, lifecycle),
    row({ agentId: "today-early", lastUserMessageAt: localAt(8, 29, 0, 1) }, lifecycle),
    row({ agentId: "week-late", lastUserMessageAt: localAt(8, 26, 20) }, lifecycle),
    row({ agentId: "today-late", lastUserMessageAt: localAt(8, 29, 0, 9) }, lifecycle),
  ];
  assert.deepEqual(
    chatDateSections(rows, AFTER_MIDNIGHT).map((group) => [group.section, group.rows.map((item) => item.thread.agentId)]),
    [
      ["today", ["today-early", "today-late"]],
      ["week", ["week-early", "week-late"]],
    ],
  );
});

test("a chat is ordered and split by when the person last wrote in it", () => {
  const lifecycle = {};
  const rows = [
    // The agent just finished and a usage report bumped it: neither moves it.
    row({ agentId: "bumped", lastUserMessageAt: NOW - 3 * HOUR, lastTurnEndedAt: NOW - MIN, updatedAt: NOW }, lifecycle),
    row({ agentId: "written", lastUserMessageAt: NOW - 20 * MIN, updatedAt: NOW - 2 * HOUR }, lifecycle),
    row({ agentId: "waiting", phase: "waiting_for_input", lastUserMessageAt: NOW - 5 * HOUR, updatedAt: NOW }, lifecycle),
    // Never written in: it counts from when it was made, not from `updatedAt`.
    row({ agentId: "fresh", createdAt: NOW - 4 * HOUR, updatedAt: NOW, lastUserMessageAt: undefined }, lifecycle),
    // Written in two days ago, though its agent finished an hour ago.
    row({ agentId: "old", lastUserMessageAt: NOW - 2 * DAY, lastTurnEndedAt: NOW - HOUR, updatedAt: NOW - HOUR }, lifecycle),
  ];
  const { recent, earlier } = chatSections(rows, NOW);
  assert.deepEqual(recent.map((item) => item.thread.agentId), ["written", "bumped", "fresh", "waiting"]);
  assert.deepEqual(earlier.map((item) => item.thread.agentId), ["old"]);
  assert.equal(chatRecencyAt(rows[3]), NOW - 4 * HOUR);
  // Ties keep the order the desktop listed them in.
  const tied = [row({ agentId: "first", lastUserMessageAt: NOW - MIN }, lifecycle), row({ agentId: "second", lastUserMessageAt: NOW - MIN }, lifecycle)];
  assert.deepEqual(chatSections(tied, NOW).recent.map((item) => item.thread.agentId), ["first", "second"]);
  // The time on a resting row is when its last turn ended, where that is listed.
  assert.equal(chatRestingAt(thread({ lastTurnEndedAt: NOW - HOUR, updatedAt: NOW })), NOW - HOUR);
});

test("finished and unseen: anyone's visit counts, and only the turn's end makes news", () => {
  const lifecycle = undefined;
  // Finished, and nobody has looked since: green.
  const ended = thread({ lastTurnEndedAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN });
  assert.equal(chatRowState(ended, { now: NOW, openedAt: NOW - HOUR }), "finished");
  // Read on the desktop after it ended: not green on the phone, which never opened it.
  const visited = thread({ lastTurnEndedAt: NOW - 10 * MIN, lastVisitedAt: NOW - 5 * MIN });
  assert.equal(chatRowState(visited, { now: NOW, openedAt: NOW - HOUR }), "idle");
  assert.equal(chatSeenAt(visited, NOW - HOUR), NOW - 5 * MIN);
  assert.equal(chatSeenAt(thread(), NOW - HOUR), NOW - HOUR);
  // Opened here after it ended, never visited on the desktop: still seen.
  assert.equal(chatRowState(ended, { now: NOW, openedAt: NOW - 5 * MIN }), "idle");
  // Seen after the turn, then renamed, restarted or reported usage: `updatedAt`
  // moves and the turn's end does not, so it stays quiet.
  const bumped = thread({ lastTurnEndedAt: NOW - 30 * MIN, lastVisitedAt: NOW - 20 * MIN, updatedAt: NOW - MIN });
  assert.equal(chatRowState(bumped, { now: NOW, openedAt: null }), "idle");
  // A chat listed with no turn end has never finished one, whatever `updatedAt` says.
  const unfinished = thread({ updatedAt: NOW - MIN, lastTurnEndedAt: undefined });
  assert.equal(chatTurnEndedAt(unfinished), null);
  assert.equal(chatHasUnseenTurn(unfinished, { now: NOW, openedAt: null }), false);
  // The day's window reads the turn's end too.
  assert.equal(chatRowState(thread({ lastTurnEndedAt: NOW - 2 * DAY, updatedAt: NOW }), { now: NOW, openedAt: null }), "idle");
  // Waiting on you is gold whatever anyone has seen.
  assert.equal(chatRowState(thread({ phase: "waiting_for_approval", lastVisitedAt: NOW }), { now: NOW }), "needs-input");
});

test("rows name the chat by the desktop's title, and settled chats never reach the list", () => {
  const workspaces = [
    { workspaceId: "w1", name: "Workspace name", projectName: "multicode", folderPath: "/x/multicode", projectKey: "repo:x", projectHue: 40 },
    { workspaceId: "w2", name: "Settled one", projectName: "multicode", folderPath: "/x/multicode", projectKey: "repo:x", projectHue: 40, settledAt: NOW - HOUR },
    { workspaceId: "w3", name: "Unsettled", projectName: "wingfoil", folderPath: "/x/wingfoil", projectKey: "repo:y", projectHue: null, settledAt: null },
  ];
  const threads = [
    thread({ workspaceId: "w1", agentId: "a", chatTitle: "Sidebar title" }),
    thread({ workspaceId: "w1", agentId: "b" }),
    thread({ workspaceId: "w2", agentId: "c" }),
    thread({ workspaceId: "w3", agentId: "d" }),
  ];
  const rows = buildChatRows({ deviceId: "mac", desktopName: "Mac", threads, workspaces, manage: true });
  assert.deepEqual(rows.map((item) => item.thread.agentId), ["a", "b", "d"]);
  assert.equal(rows[0].workspaceChats, 2, "a settled workspace's chats are not counted either");
  assert.equal(rows[0].settleable, true);
  assert.equal(chatRowTitle(rows[0]).title, "Sidebar title");
  assert.equal(chatRowTitle(rows[1]).title, "Workspace name", "without a chat title, the workspace's name as before");
  assert.equal(matchesChatSearch(rows[0], "sidebar"), true);
  // Settled chats leave the project groups with the list.
  assert.deepEqual(groupChatsByProject(rows, NOW).map((group) => group.rows.length), [2, 1]);
  // A grant that does not reach the chats' rest settles nothing; an unreadable workspace list drops nothing.
  const readOnly = buildChatRows({ deviceId: "mac", desktopName: "Mac", threads, workspaces, manage: false });
  assert.equal(readOnly[0].settleable, false);
  const unlisted = buildChatRows({ deviceId: "mac", desktopName: "Mac", threads, workspaces: null, manage: true });
  assert.equal(unlisted.length, 4);
  assert.equal(unlisted[0].projectName, null);
});

test("search covers the title, the project, the machine and the CLI", () => {
  const item = row({ title: "Toast timeouts on the phone" }, { desktopName: "build-box", projectName: "mobile" });
  assert.equal(matchesChatSearch(item, ""), true);
  assert.equal(matchesChatSearch(item, "  TOAST "), true);
  assert.equal(matchesChatSearch(item, "mobile"), true);
  assert.equal(matchesChatSearch(item, "build"), true);
  assert.equal(matchesChatSearch(item, "claude code"), true);
  assert.equal(matchesChatSearch(item, "relay"), false);
  assert.equal(matchesChatSearch({ ...item, projectName: null }, "mobile"), false);
});

test("a chat's opened key cannot collide with another desktop's agent", () => {
  assert.equal(chatOpenedKey("mac-mini-id", "agent-1"), "chat:mac-mini-id:agent-1");
  assert.notEqual(chatOpenedKey("mac-mini-id", "agent-1"), chatOpenedKey("build-box-id", "agent-1"));
});

test("New offers a chat only where the desktop's Studio lets this pairing drive its chats", () => {
  const offers = { said: true, follow: true, operate: true };
  assert.deepEqual(chatLaunchAvailability(offers, { machineName: "mac-mini" }), { available: true });
  assert.match(
    chatLaunchAvailability({ ...offers, operate: false }, { machineName: "mac-mini" }).reason,
    /may read chats on mac-mini but not start them/,
  );
  assert.match(
    chatLaunchAvailability({ ...offers, follow: false, operate: false }, { machineName: "mac-mini" }).reason,
    /^This phone may not use chats on mac-mini/,
  );
  // Before the desktop has said anything, nothing is refused: the create itself says what went wrong.
  assert.deepEqual(chatLaunchAvailability({ said: false, follow: false, operate: false }, { machineName: "" }), { available: true });
  assert.deepEqual(chatLaunchAvailability(null, { machineName: "" }), { available: true });
});

test("New needs chat control and the projects; the workspace grant is read or operate, never a terminal scope", () => {
  const session = {
    deviceId: "mac-mini-id",
    desktopName: "mac-mini",
    baseUrl: "http://mac-mini:4100",
    deviceToken: "mctn_example",
    pairedAt: "2026-09-01T00:00:00.000Z",
    tailnetScopes: ["workspace:read", "conversation:operate"],
    status: "online",
  };
  assert.equal(canReadWorkspaces(session), true);
  // Operate implies read within a family, as the gateway rules it.
  assert.equal(canReadWorkspaces({ ...session, tailnetScopes: ["workspace:operate"] }), true);
  assert.equal(canReadWorkspaces({ ...session, tailnetScopes: ["conversation:operate", "terminal:control"] }), false);
  assert.equal(canReadWorkspaces({ ...session, status: "revoked" }), false);

  assert.equal(canStartChats(session, { operate: true }), true);
  assert.equal(canStartChats(session, { operate: false }), false, "the Studio's grant does not drive its chats");
  assert.equal(canStartChats({ ...session, tailnetScopes: ["conversation:operate"] }, { operate: true }), false);
});

test("New lists each project once: every chat in a folder answers for the folder, and a worktree stays its own", () => {
  const workspace = (workspaceId, folderPath) => ({
    workspaceId,
    folderPath,
    projectName: folderPath ? folderPath.split("/").filter(Boolean).at(-1) : "Chat",
  });
  const projects = pickableProjects([
    workspace("ws-7", "/Users/dev/wingfoil"),
    workspace("ws-3", "/Users/dev/wingfoil/"),
    workspace("ws-5", "/Users/dev/wingfoil"),
    workspace("ws-9", "/Users/dev/acme"),
    workspace("ws-2", "/Users/dev/worktrees/wingfoil"),
    workspace("ws-4", null),
  ]);
  assert.deepEqual(
    projects.map((project) => [project.projectName, project.folderPath, project.workspaceId]),
    [
      ["acme", "/Users/dev/acme", "ws-9"],
      ["wingfoil", "/Users/dev/wingfoil", "ws-3"],
      ["wingfoil", "/Users/dev/worktrees/wingfoil", "ws-2"],
    ],
  );
});

test("a list read keeps each chat that has not moved as the row the list holds", () => {
  const { keepUnchanged } = require("../../../.mobile-test-build/mobile/src/features/conversations/keepUnchanged.js");
  const key = (row) => JSON.stringify([row.deviceId, row.thread.workspaceId, row.thread.agentId]);
  // Every read parses the desktop's answer afresh.
  const read = (count, moved = -1) =>
    Array.from({ length: count }, (_, index) => ({
      deviceId: "desk",
      desktopName: "Desk",
      projectName: "web",
      thread: { workspaceId: `w${index}`, agentId: `a${index}`, title: `Chat ${index}`, phase: "idle", updatedAt: index === moved ? 99 : index, models: { cli: "claude", options: [{ id: "m", label: "M" }] } },
    }));
  const held = read(3);
  assert.equal(keepUnchanged(held, read(3), key), held, "nothing moved: the same list");
  const grown = keepUnchanged(held, read(4), key);
  assert.deepEqual(grown.map((row, index) => row === held[index]), [true, true, true, false]);
  const moved = keepUnchanged(held, read(3, 1), key);
  assert.deepEqual(moved.map((row, index) => row === held[index]), [true, false, true]);
  assert.equal(moved[1].thread.updatedAt, 99);
});

test("a chat in one of a project's worktrees is the project's in New's picker, asked about through the project's own folder", () => {
  const workspace = (workspaceId, folderPath, projectFolder, worktree) => ({
    workspaceId,
    folderPath,
    projectName: "multicode",
    projectFolder,
    worktree,
  });
  const ROOT = "/Users/dev/code/multicode";
  const projects = pickableProjects([
    workspace("ws-1", "/Users/dev/code/.sprintengine-worktrees/multicode/pool-02", ROOT, "pool-02"),
    workspace("ws-8", ROOT, ROOT, null),
    workspace("ws-0", "/Users/dev/code/.sprintengine-worktrees/multicode/pool-01", ROOT, "pool-01"),
  ]);
  // One project, not three, and asked about through its own folder even
  // though a worktree's workspace has a lower id.
  assert.deepEqual(projects, [{ key: ROOT.toLowerCase(), projectName: "multicode", folderPath: ROOT, workspaceId: "ws-8", worktree: null }]);
  // With no workspace in the project's folder, the lowest worktree's, named.
  const onlyWorktrees = pickableProjects([
    workspace("ws-1", "/Users/dev/code/.sprintengine-worktrees/multicode/pool-02", ROOT, "pool-02"),
    workspace("ws-0", "/Users/dev/code/.sprintengine-worktrees/multicode/pool-01", ROOT, "pool-01"),
  ]);
  assert.deepEqual(onlyWorktrees.map((project) => [project.projectName, project.workspaceId, project.worktree]), [["multicode", "ws-0", "pool-01"]]);
});

test("a worktree chat's row and its project group wear the project's name, and the row says it runs in a worktree", () => {
  const ROOT = "/Users/dev/code/multicode";
  const workspaces = [
    { workspaceId: "ws-main", name: "Main", projectName: "multicode", folderPath: ROOT, projectFolder: ROOT, worktree: null, projectKey: "repo:github.com/acme/multicode", projectHue: 262 },
    {
      workspaceId: "ws-pool",
      name: "Pool",
      projectName: "multicode",
      folderPath: "/Users/dev/code/.sprintengine-worktrees/multicode/pool-02",
      projectFolder: ROOT,
      worktree: "pool-02",
      projectKey: "repo:github.com/acme/multicode",
      projectHue: 262,
    },
  ];
  const threads = [thread({ workspaceId: "ws-main", agentId: "a" }), thread({ workspaceId: "ws-pool", agentId: "b" })];
  const rows = buildChatRows({ deviceId: "mac", desktopName: "Mac", threads, workspaces, manage: true });
  assert.deepEqual(rows.map((item) => [item.projectName, item.worktree]), [["multicode", null], ["multicode", "pool-02"]]);
  const groups = groupChatsByProject(rows, NOW);
  assert.deepEqual(groups.map((group) => [group.projectName, group.rows.length]), [["multicode", 2]]);
});

const link = (environmentId, chatId, agentId = null) => ({ kind: "chat", environmentId, chatId, agentId });

test("a chat link opens the chat on the desktop that is its environment, and only there", () => {
  const mine = row({ workspaceId: "ws-docs", agentId: "agent-a" }, { deviceId: "dev-a", environmentId: "env-a" });
  const other = row({ workspaceId: "ws-other", agentId: "agent-b" }, { deviceId: "dev-a", environmentId: "env-a" });
  const twin = row({ workspaceId: "ws-docs", agentId: "agent-c" }, { deviceId: "dev-b", environmentId: "env-b" });
  assert.deepEqual(resolveChatLink(link("env-a", "ws-docs"), [other, mine, twin]), { kind: "one", row: mine });
  assert.deepEqual(resolveChatLink(link("env-b", "ws-docs"), [other, mine, twin]), { kind: "one", row: twin });
  assert.deepEqual(resolveChatLink(link("env-a", "ws-gone"), [other, mine, twin]), { kind: "none" });
  // A desktop that has said it is another environment never holds it.
  assert.deepEqual(resolveChatLink(link("env-c", "ws-docs"), [other, mine, twin]), { kind: "none" });
  // One desktop reached by two pairings is one environment, and one chat.
  const again = { ...mine, deviceId: "dev-a-again" };
  assert.deepEqual(resolveChatLink(link("env-a", "ws-docs"), [mine, again]), { kind: "one", row: mine });
});

test("while no desktop has said it is the link's environment, a desktop that has said none may be it", () => {
  const unsaid = row({ workspaceId: "ws-docs", agentId: "agent-a" }, { deviceId: "dev-old" });
  const said = row({ workspaceId: "ws-docs", agentId: "agent-b" }, { deviceId: "dev-b", environmentId: "env-b" });
  assert.deepEqual(resolveChatLink(link("env-a", "ws-docs"), [unsaid, said]), { kind: "one", row: unsaid });
  assert.deepEqual(resolveChatLink(link("env-b", "ws-docs"), [unsaid, said]), { kind: "one", row: said });
});

test("an old link opens the one desktop that lists its workspace, offers several, and says none", () => {
  const mine = row({ workspaceId: "ws-docs", agentId: "agent-a", lastUserMessageAt: NOW - HOUR }, { deviceId: "dev-a" });
  const other = row({ workspaceId: "ws-other", agentId: "agent-b" }, { deviceId: "dev-a" });
  assert.deepEqual(resolveChatLink(link(null, "ws-docs"), [other, mine]), { kind: "one", row: mine });
  assert.deepEqual(resolveChatLink(link(null, "ws-gone"), [other, mine]), { kind: "none" });
  assert.deepEqual(resolveChatLink(link(null, "ws-docs"), []), { kind: "none" });

  // The same workspace on two paired desktops: the person picks, in the list's order.
  const twin = row({ workspaceId: "ws-docs", agentId: "agent-c" }, { deviceId: "dev-b" });
  assert.deepEqual(resolveChatLink(link(null, "ws-docs"), [mine, other, twin]), { kind: "several", rows: [mine, twin] });
});

test("a chat link's agent picks its chat in the workspace, else the chat last written in", () => {
  const older = row({ workspaceId: "ws", agentId: "agent-old", lastUserMessageAt: NOW - 3 * HOUR }, { lifecycle: true });
  const newer = row({ workspaceId: "ws", agentId: "agent-new", lastUserMessageAt: NOW - HOUR }, { lifecycle: true });
  assert.equal(resolveChatLink(link(null, "ws"), [older, newer]).row, newer);
  assert.equal(resolveChatLink(link(null, "ws", "agent-old"), [older, newer]).row, older);
  assert.equal(resolveChatLink(link(null, "ws", "agent-old"), [newer, older]).row, older);
  // An agent the workspace does not have still opens the chat, as it was left.
  assert.equal(resolveChatLink(link(null, "ws", "agent-gone"), [older, newer]).row, newer);
});

test("a desktop's rows carry its environment id when it has said one", () => {
  const threads = [thread({ workspaceId: "ws-1", agentId: "a" })];
  const said = buildChatRows({ deviceId: "mac", desktopName: "Mac", environmentId: "env-mac", threads, workspaces: null, manage: true });
  assert.equal(said[0].environmentId, "env-mac");
  const unsaid = buildChatRows({ deviceId: "mac", desktopName: "Mac", threads, workspaces: null, manage: true });
  assert.equal("environmentId" in unsaid[0], false);
});

test("a chat opened in a screen's place keeps what was under it, and the list under a link that started the app", () => {
  const home = { name: "HomeOverview" };
  const chat = { name: "Conversation", params: { deviceId: "dev-a" } };
  assert.deepEqual(routesInPlaceOfTop([home, { name: "ChatLink" }], chat, home), [home, chat]);
  assert.deepEqual(routesInPlaceOfTop([{ name: "ChatLink" }], chat, home), [home, chat]);
  assert.deepEqual(routesInPlaceOfTop([home, { name: "Notices" }, { name: "Conversation" }], chat, home), [home, { name: "Notices" }, chat]);
});
