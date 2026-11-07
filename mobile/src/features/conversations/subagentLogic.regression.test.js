const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  chatSubagentName,
  chatSubagentStatus,
  directLanes,
  isSubagentStart,
  parentRelation,
  stepsBackTo,
  subagentCounts,
  subagentEntries,
  subagentEntryWords,
  subagentStartFacts,
  subagentThread,
  subagentsFooter,
} = require("../../../.mobile-test-build/src/features/conversations/subagentLogic.js");

const subagent = (over = {}) => ({
  workspaceId: "ws", agentId: "child", title: "Review the diff", providerId: "cursor-agent", modelId: "default",
  readOnly: false, status: "working", task: "Review the diff", startedAt: 1_000, ...over,
});
const lane = (over = {}) => ({ id: "lane", turn: "t", task: "Find the call sites", status: "running", startedAt: 2_000, messages: [], steps: [], ...over });

test("a subagent chat says how it stands in the desktop's words", () => {
  assert.deepEqual(chatSubagentStatus(subagent({ status: "needs_input" }), 9_000), { text: "Waiting on you", tone: "waiting" });
  assert.deepEqual(chatSubagentStatus(subagent(), 43_000), { text: "Working · 42s", tone: "working" });
  assert.deepEqual(chatSubagentStatus(subagent({ status: "working", endedAt: 5_000 }), 43_000), { text: "Working", tone: "working" });
  assert.deepEqual(chatSubagentStatus(subagent({ status: "completed", endedAt: 65_000 }), 0), { text: "Done in 1m 4s", tone: "quiet" });
  assert.deepEqual(chatSubagentStatus(subagent({ status: "failed", endedAt: 10_000 }), 0), { text: "Failed after 9s", tone: "failed" });
  assert.deepEqual(chatSubagentStatus(subagent({ status: "stopped" }), 0), { text: "Stopped", tone: "quiet" });
  assert.equal(chatSubagentName(subagent({ title: " ", task: "" })), "Subagent");
});

test("a subagent opens as a chat of its own, on its parent's machine", () => {
  const parent = { workspaceId: "ws", agentId: "parent", title: "Main", phase: "idle", updatedAt: 0, createdAt: 0, providerId: "claude-agent", modelId: "default", turnCount: 3, lastSeq: 40, host: { id: "ssh:build-box", kind: "ssh", label: "build-box", color: "teal" } };
  const thread = subagentThread(subagent({ status: "needs_input", sessionId: "s1", permissionPreset: "manual" }), parent);
  assert.equal(thread.agentId, "child");
  assert.equal(thread.phase, "waiting_for_input");
  assert.equal(thread.lastSeq, 0, "its own log, read from the start");
  assert.equal(thread.sessionId, "s1");
  assert.equal(thread.host.label, "build-box");
  assert.equal(parentRelation({ kind: "chat", agentId: "parent", name: "Main", main: true }), "Main chat");
  assert.equal(parentRelation({ kind: "lane", laneId: "x", name: "Explore" }), "Parent agent");
});

test("only a chat's own subagents are listed, never a grandchild", () => {
  const lanes = [lane({ id: "a" }), lane({ id: "b", parentId: "a" }), lane({ id: "c", parentId: "b" })];
  assert.deepEqual(directLanes(lanes).map((entry) => entry.id), ["a"]);
  assert.deepEqual(directLanes(lanes, "a").map((entry) => entry.id), ["b"]);
  assert.deepEqual(directLanes(lanes, "b").map((entry) => entry.id), ["c"]);
  assert.deepEqual(subagentCounts(lanes, [subagent(), subagent({ agentId: "d", status: "completed" })]), { total: 3, working: 2 });
});

test("the list puts what works first, oldest first, and what finished newest first", () => {
  const { working, finished } = subagentEntries({
    lanes: [lane({ id: "l1", startedAt: 3_000 }), lane({ id: "l2", status: "done", outcome: "ok", startedAt: 500 })],
    subagents: [subagent({ startedAt: 4_000 }), subagent({ agentId: "old", status: "completed", startedAt: 1_000, endedAt: 2_000 })],
  });
  assert.deepEqual(working.map((entry) => entry.key), ["lane:l1", "chat:child"]);
  assert.deepEqual(finished.map((entry) => entry.key), ["chat:old", "lane:l2"]);
  assert.equal(subagentEntryWords(working[1], 6_000).text, "Working · 2s");
  assert.equal(subagentEntryWords(working[0], 6_000).name, "Find the call sites");
  assert.equal(subagentsFooter(2, 0), "2 working");
  assert.equal(subagentsFooter(1, 3), "1 working · 3 finished");
});

test("subagent.start reads as who it started, and finds the chat it made", () => {
  assert.equal(isSubagentStart({ name: "mcp__sprintengine-studio__subagent_start", serverName: "sprintengine-studio" }), true);
  assert.equal(isSubagentStart({ name: "subagent.start" }), true);
  assert.equal(isSubagentStart({ name: "mcp__other__subagent_start", serverName: "other" }), false);
  const facts = subagentStartFacts(
    { input: { cli: "cursor", cliModel: "muse-wonder-1.0[1m]", readOnly: true }, output: JSON.stringify({ subagentId: "child", result: "ok" }) },
    "claude-code",
  );
  assert.deepEqual(facts, { subagentId: "child", cli: "cursor", words: "Started a subagent · Cursor · muse-wonder-1.0 · Read-only" });
  const cut = subagentStartFacts({ input: {}, output: '{"subagentId": "child2", "result": "a long reply cut sho' }, "codex");
  assert.equal(cut.subagentId, "child2", "a cut answer still names its chat");
  assert.equal(cut.cli, "codex", "no CLI named: the chat's own");
  assert.equal(cut.words, "Started a subagent");
});

test("a parent's link goes back to its screen under the top when it is there", () => {
  const routes = ["Home", "Conversation:parent", "ConversationAgents", "Conversation:child", "ConversationAgents"];
  assert.equal(stepsBackTo(routes, (route) => route === "Conversation:parent"), 3);
  assert.equal(stepsBackTo(routes, (route) => route === "ConversationAgents"), 2, "the nearest under the top");
  assert.equal(stepsBackTo(routes, (route) => route === "ConversationAgents" && false), null);
  assert.equal(stepsBackTo(["Conversation:parent"], () => true), null, "the top itself is not under the top");
});

test("a subagent the turn started stays in view, out of the turn's fold", () => {
  const { foldTurns } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
  const read = { id: "r", name: "Read", input: { path: "a.ts" }, status: "ok" };
  const start = { id: "s", name: "mcp__sprintengine-studio__subagent_start", serverName: "sprintengine-studio", input: {}, status: "ok" };
  const grep = { id: "g", name: "Grep", input: { pattern: "x" }, status: "ok" };
  const rows = foldTurns(
    [
      { kind: "tools", id: "t1", turn: "t", tools: [read, start, grep] },
      { kind: "message", id: "m", role: "assistant", turn: "t", text: "Done.", at: 1 },
    ],
    () => ({ status: "done", steps: 2 }),
  );
  const kept = rows.filter((row) => row.kind === "tools");
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].tools.map((tool) => tool.id), ["s"]);
  const fold = rows.find((row) => row.kind === "fold");
  assert.deepEqual(fold.parts.flatMap((part) => part.tools ?? []).map((tool) => tool.id), ["r", "g"]);
});
