/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

// A chat's rest, visit clock and marks on its desktop, from the phone: the
// desktop's own `conversation.*` methods on its Studio protocol, each change
// under a command id, the visit with none. A read-only pairing is told it may
// not; a desktop from before the protocol, to update.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { createChatLifecycleApi, snoozeInstant } = require(path.join(buildRoot, "src/api/chatLifecycle.js"));
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

let desktops = 0;
/** A paired desktop of its own for each case: the phone keeps one connection per desktop. */
const target = () => ({ baseUrl: `http://mac-mini-${++desktops}:4100`, deviceToken: "mctn_example" });

test("settle, visit, mark unread and snooze are the desktop's own methods, each change under a command id", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["conversation:read", "conversation:operate"],
    answer: (method, params) =>
      method === "conversation.settle"
        ? { settledAt: params.settled === false ? null : 42 }
        : method === "conversation.visit"
          ? { lastVisitedAt: 43 }
          : method === "conversation.markUnread"
            ? { lastVisitedAt: 41 }
            : { snoozedUntil: params.until },
  });
  const api = createChatLifecycleApi(target(), { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  assert.deepEqual(await api.settle("w1"), { ok: true, data: { workspaceId: "w1", settledAt: 42 } });
  assert.deepEqual(await api.settle("w1", false), { ok: true, data: { workspaceId: "w1", settledAt: null } });
  assert.deepEqual(await api.visit("w1"), { ok: true, data: { workspaceId: "w1", lastVisitedAt: 43 } });
  assert.deepEqual(await api.markUnread("w1"), { ok: true, data: { workspaceId: "w1", lastVisitedAt: 41 } });
  assert.deepEqual(await api.snooze("w1", 5_000.7), { ok: true, data: { workspaceId: "w1", snoozedUntil: 5_000 } });
  assert.deepEqual(await api.snooze("w1", null), { ok: true, data: { workspaceId: "w1", snoozedUntil: null } });

  const [settle, unsettle, visit, mark, snooze] = desktop.requests;
  assert.equal(settle.method, "conversation.settle");
  assert.equal(settle.params.workspaceId, "w1");
  assert.equal("settled" in settle.params, false, "`settled` is sent only to un-settle");
  assert.equal(unsettle.params.settled, false);
  assert.notEqual(settle.params.commandId, unsettle.params.commandId, "each change is a command of its own");
  // No instant and no command id: the desktop stamps its own clock, only forward.
  assert.deepEqual(visit, { method: "conversation.visit", params: { workspaceId: "w1" } });
  assert.match(mark.params.commandId, /^chat-/u);
  assert.equal(snooze.params.until, 5_000);
  assert.equal(desktop.ticketHeaders[0].authorization, "Bearer mctn_example");
  closeDesktopStudios();
});

test("a refusal comes back in the desktop's words, never a throw", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["conversation:read", "conversation:operate"],
    answer: (method) =>
      method === "conversation.markUnread"
        ? { error: { code: "conflict", message: "No agent in this chat has finished anything yet." } }
        : { error: { code: "conflict", message: "An agent in this chat is still working." } },
  });
  const api = createChatLifecycleApi(target(), { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  const unread = await api.markUnread("w1");
  assert.equal(unread.ok, false);
  assert.equal(unread.message, "No agent in this chat has finished anything yet.");
  const snoozed = await api.snooze("w1", Date.now() + 60_000);
  assert.equal(snoozed.message, "An agent in this chat is still working.");
  closeDesktopStudios();
});

test("a read-only pairing is told it may not, and a desktop from before the protocol to update", async () => {
  const reader = fakeDesktopStudio({
    scopes: ["conversation:read"],
    answer: () => ({ error: { code: "scope_required", message: "This pairing may not do that." } }),
  });
  const refused = await createChatLifecycleApi(target(), { fetchImpl: reader.fetchImpl, WebSocket: reader.WebSocket }).settle("w1");
  assert.equal(!refused.ok && refused.errorCode, "unauthorized");

  const older = fakeDesktopStudio({ answer: () => ({}), outdated: true });
  const old = await createChatLifecycleApi(target(), { fetchImpl: older.fetchImpl, WebSocket: older.WebSocket }).visit("w1");
  assert.equal(!old.ok && old.errorCode, "command_not_supported");
  closeDesktopStudios();
});

test("a snooze wakes at a whole millisecond, or now", () => {
  assert.equal(snoozeInstant(1_234.9), 1_234);
  assert.equal(snoozeInstant(null), null);
});
