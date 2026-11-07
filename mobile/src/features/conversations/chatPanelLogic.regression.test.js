const assert = require("node:assert/strict");
const { test } = require("node:test");
const { serverWords, usageMeta, usageSub, usageTone, usageWindow } = require("../../../.mobile-test-build/src/features/conversations/chatPanelLogic.js");

const window = (over = {}) => ({ id: "five_hour", label: "5-hour limit", usedPercent: 42, resetsAt: null, status: "allowed", observedAt: 1, ...over });

test("a chat's servers say whether they answer", () => {
  assert.equal(serverWords(undefined), null);
  assert.deepEqual(serverWords([{ id: "a", url: "http://localhost:5173", title: "dev-site", port: 5173, state: "running" }]), {
    meta: "Running", sub: "dev-site · port 5173",
  });
  const many = serverWords([
    { id: "a", url: "http://localhost:1", title: "web", port: 1, state: "running" },
    { id: "b", url: "http://localhost:2", title: "", port: 2, state: "stopped" },
  ]);
  assert.deepEqual(many, { meta: "1 running", sub: "web, port 2" });
});

test("the Usage row reads the chat's own plan, nearest its limit, a refused window first", () => {
  const limits = [
    { provider: "codex", windows: [window({ id: "codex:primary", usedPercent: 90 })], observedAt: 1 },
    { provider: "claude", windows: [window(), window({ id: "seven_day", label: "Weekly limit", usedPercent: 71 })], observedAt: 1 },
  ];
  assert.equal(usageWindow(limits, "claude-code").window.id, "seven_day");
  assert.equal(usageWindow(limits, "codex").window.id, "codex:primary");
  assert.equal(usageWindow(limits, "cursor").window.id, "codex:primary", "a CLI with no known plan reads any");
  const refused = [{ provider: "claude", windows: [window({ usedPercent: 99 }), window({ id: "x", usedPercent: null, status: "rejected" })], observedAt: 1 }];
  assert.equal(usageWindow(refused, "claude-code").window.id, "x");
  assert.equal(usageWindow([], "claude-code"), null);
});

test("a window says its share, its reset, and its tone", () => {
  assert.equal(usageMeta(window()), "42%");
  assert.equal(usageMeta(window({ status: "rejected" })), "Limit reached");
  assert.equal(usageMeta(window({ usedPercent: null })), "In use");
  assert.equal(usageSub(window({ resetsAt: 5 }), () => "3:00 PM"), "5-hour limit · resets 3:00 PM");
  assert.equal(usageSub(window(), () => "never"), "5-hour limit");
  assert.equal(usageTone(window()), "muted");
  assert.equal(usageTone(window({ usedPercent: 85 })), "warn");
  assert.equal(usageTone(window({ status: "rejected" })), "error");
});
