const assert = require("node:assert/strict");
const { test } = require("node:test");
const { projectPhoneConversation } = require("../../../.mobile-test-build/mobile/src/features/conversations/conversationLogic.js");
const {
  fileViewExcerpt,
  fileViewFiles,
  fileViewLabels,
  fileViewLanguage,
  phoneShownToUser,
  pluginOffer,
  shownCard,
} = require("../../../.mobile-test-build/mobile/src/features/conversations/shownSteps.js");
const { phoneChatOffers } = require("../../../.mobile-test-build/mobile/src/api/chatOffers.js");

// What an agent showed the person (files with Studio's `file.view`, a plugin
// with `plugin.offer`) is a card of its own under the turn's line, as on the
// desktop, and not a step of its work. A step leaves the fold only together
// with its card: where the phone cannot draw the card, the call stays the
// ordinary step it was, folded and counted.

let seq = 0;
function event(type, payload) {
  seq += 1;
  return { id: `event-${seq}`, seq, sessionId: "session", workspaceId: "ws", agentId: "agent", createdAt: seq * 1_000, type, payload };
}

const STUDIO = { serverName: "sprintengine-studio" };
const SHOWN = {
  ok: true,
  files: [
    { path: "/Users/dev/app/docs/pairing.md", name: "pairing.md", lines: 30, highlights: [{ from: 12, to: 14, note: "The grant" }] },
    { path: "/Users/dev/app/CLAUDE.md", name: "CLAUDE.md", lines: 4, highlights: [] },
  ],
};
const OFFERED = { ok: true, sourceId: "acme", source: "Acme plugins", pluginId: "sheets", name: "Sheets", description: "Reads spreadsheets." };

// A turn that read a file, showed two, offered a plugin and replied.
function shownTurn({ viewStatus = "ok", offerStatus = "ok" } = {}) {
  const turnId = "turn";
  return [
    event("user_message", { turnId, text: "show me the notes" }),
    event("turn_started", { turnId }),
    event("tool_started", { turnId, toolUseId: "read", name: "Read", input: { path: "docs/pairing.md" } }),
    event("tool_output", { turnId, toolUseId: "read", output: "…" }),
    event("tool_started", { turnId, toolUseId: "view", name: "mcp__sprintengine-studio__file_view", ...STUDIO, input: { files: [] } }),
    event("tool_output", {
      turnId,
      toolUseId: "view",
      output: viewStatus === "error" ? "No file could be shown." : JSON.stringify(SHOWN),
      ...(viewStatus === "error" ? { isError: true, status: "error" } : {}),
    }),
    event("tool_started", { turnId, toolUseId: "offer", name: "mcp__sprintengine-studio__plugin_offer", ...STUDIO, input: { sourceId: "acme", pluginId: "sheets" } }),
    event("tool_output", {
      turnId,
      toolUseId: "offer",
      output: offerStatus === "error" ? "unknown_plugin" : JSON.stringify(OFFERED),
      ...(offerStatus === "error" ? { isError: true, status: "error" } : {}),
    }),
    event("content_delta", { turnId, text: "Here they are." }),
    event("turn_completed", { turnId }),
  ];
}

const foldOf = (rows) => rows.find((row) => row.kind === "fold");
const foldedSteps = (fold) => fold.parts.flatMap((part) => (part.kind === "tools" ? part.tools : []));

test("with the desktop serving shown files, the file view and the plugin offer are the person's, not counted as steps", () => {
  const { rows } = projectPhoneConversation(shownTurn(), { fileViews: true });
  const fold = foldOf(rows);
  assert.match(fold.label, /· 1 step$/u, "only the read is work");
  // The cards' steps ride with the fold's parts, for the view to draw under its line.
  assert.deepEqual(foldedSteps(fold).map((tool) => tool.id), ["read", "view", "offer"]);
  assert.match(rows.find((row) => row.kind === "message" && row.role === "assistant").text, /^Here they are/u);
});

test("without it, the file view stays an ordinary step in the fold, counted; the plugin offer needs nothing of the desktop", () => {
  const { rows } = projectPhoneConversation(shownTurn(), { fileViews: false });
  assert.match(foldOf(rows).label, /· 2 steps$/u, "the read and the file view");
  // The default, before the desktop has said anything, is the same.
  assert.match(foldOf(projectPhoneConversation(shownTurn()).rows).label, /· 2 steps$/u);
});

test("a call that failed is its step, counted and failed, with or without the card", () => {
  const { rows } = projectPhoneConversation(shownTurn({ viewStatus: "error", offerStatus: "error" }), { fileViews: true });
  const fold = foldOf(rows);
  assert.match(fold.label, /· 3 steps$/u);
  assert.equal(fold.failed, 2);
});

test("a turn whose only steps showed the person something has no fold", () => {
  const turnId = "only";
  const { rows } = projectPhoneConversation(
    [
      event("turn_started", { turnId }),
      event("tool_started", { turnId, toolUseId: "view", name: "file_view", ...STUDIO }),
      event("tool_output", { turnId, toolUseId: "view", output: JSON.stringify(SHOWN) }),
      event("turn_completed", { turnId }),
    ],
    { fileViews: true },
  );
  assert.deepEqual(rows.map((row) => row.kind), ["tools", "meta"]);
});

test("a card is Studio's call alone, under any runtime's spelling, and never a failed one", () => {
  const cards = { fileViews: true };
  for (const name of ["mcp__sprintengine-studio__file_view", "sprintengine-studio.file_view"])
    assert.equal(shownCard({ name, status: "ok" }, cards), "file-view", name);
  assert.equal(shownCard({ name: "file_view", serverName: "sprintengine-studio", status: "ok" }, cards), "file-view");
  assert.equal(shownCard({ name: "mcp__other__file_view", status: "ok" }, cards), null, "another server's tool of the name");
  assert.equal(shownCard({ name: "mcp__sprintengine-studio__plugin_offer", status: "ok" }, { fileViews: false }), "plugin-offer");
  assert.equal(shownCard({ name: "mcp__sprintengine-studio__file_view", status: "ok" }, { fileViews: false }), null);
  assert.equal(shownCard({ name: "mcp__sprintengine-studio__plugin_offer", status: "error" }, cards), null);
  assert.equal(phoneShownToUser({ name: "GenerateImage", status: "ok" }, { fileViews: false }), true, "a picture, as before");
  assert.equal(phoneShownToUser({ name: "Read", status: "ok" }, cards), false);
});

test("the files are read from the call's answer, each once, by the path Studio resolved", () => {
  const files = fileViewFiles({ status: "ok", output: JSON.stringify({ ...SHOWN, files: [...SHOWN.files, SHOWN.files[0], { path: "" }, 7] }) });
  assert.deepEqual(files.map((file) => file.path), ["/Users/dev/app/docs/pairing.md", "/Users/dev/app/CLAUDE.md"]);
  assert.deepEqual(files[0].highlights, [{ from: 12, to: 14, note: "The grant" }]);
  // Nothing to draw: the call stays its step.
  assert.deepEqual(fileViewFiles({ status: "running", output: JSON.stringify(SHOWN) }), []);
  assert.deepEqual(fileViewFiles({ status: "error", output: JSON.stringify(SHOWN) }), []);
  assert.deepEqual(fileViewFiles({ status: "ok", output: "{\"ok\":true,\"files\":[{\"path\":\"/a" }), [], "cut short on the wire");
  // A highlight is read defensively: whole lines, a range never backwards.
  const odd = fileViewFiles({
    status: "ok",
    output: JSON.stringify({ files: [{ path: "/a/b.ts", highlights: [{ from: 9.7, to: 2 }, { from: "3" }, { from: 0, note: "  " }] }] }),
  });
  assert.deepEqual(odd[0].highlights, [{ from: 1, to: 1 }, { from: 9, to: 9 }]);
  assert.equal(odd[0].name, "b.ts");
});

test("two files of one name are told apart by their folders", () => {
  const files = [
    { path: "/Users/dev/a/CLAUDE.md", name: "CLAUDE.md", highlights: [] },
    { path: "/Users/dev/b/CLAUDE.md", name: "CLAUDE.md", highlights: [] },
    { path: "/Users/dev/a/notes.md", name: "notes.md", highlights: [] },
  ];
  assert.deepEqual(fileViewLabels(files), ["a/CLAUDE.md", "b/CLAUDE.md", "notes.md"]);
});

test("a card opens where the agent pointed, and Show all reads the file from its top", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const top = fileViewExcerpt(text, [], false);
  assert.equal(top.firstLine, 1);
  assert.equal(top.text.split("\n")[0], "line 1");
  assert.equal(top.total, 100);
  assert.equal(top.hidden, 82);
  const pointed = fileViewExcerpt(text, [{ from: 40, to: 42 }], false);
  assert.equal(pointed.firstLine, 38, "two lines above the first range");
  assert.equal(pointed.text.split("\n")[0], "line 38");
  assert.equal(pointed.text.split("\n").length, 18);
  assert.equal(pointed.hidden, 82);
  // Near the end, the window stays full rather than running off the file.
  assert.equal(fileViewExcerpt(text, [{ from: 99, to: 99 }], false).firstLine, 83);
  const all = fileViewExcerpt(text, [{ from: 40, to: 42 }], true);
  assert.equal(all.firstLine, 1);
  assert.equal(all.hidden, 0);
  assert.equal(fileViewExcerpt("", [], false).total, 0);
  assert.equal(fileViewLanguage("grants.ts"), "ts");
  assert.equal(fileViewLanguage("pairing.md"), undefined);
});

test("a plugin offer is drawn from Studio's answer, and only from one that names a plugin", () => {
  assert.deepEqual(pluginOffer({ status: "ok", output: JSON.stringify(OFFERED) }), {
    name: "Sheets",
    description: "Reads spreadsheets.",
    source: "Acme plugins",
  });
  assert.equal(pluginOffer({ status: "ok", output: JSON.stringify({ ok: false, name: "Sheets" }) }), null);
  assert.equal(pluginOffer({ status: "ok", output: JSON.stringify({ ok: true }) }), null);
  assert.equal(pluginOffer({ status: "running", output: JSON.stringify(OFFERED) }), null);
  assert.equal(pluginOffer({ status: "ok", output: "not json" }), null);
});

test("shown files are read where the desktop serves them and this pairing follows its chats", () => {
  const welcome = (capabilities, scopes = ["conversation:read"]) => ({
    capabilities: ["conversations", "conversation-sessions", ...capabilities],
    conversation: { protocolVersion: 1, minProtocolVersion: 1, capabilities: [] },
    grant: { clientId: "tailnet:phone", name: "android-phone", owner: false, scopes, ceiling: "bypass" },
  });
  assert.equal(phoneChatOffers(welcome(["file-views"])).fileViews, true, "reading needs only conversation:read");
  assert.equal(phoneChatOffers(welcome([])).fileViews, false, "a Studio from before file views");
  assert.equal(phoneChatOffers(welcome(["file-views"], [])).fileViews, false, "a pairing that may not follow chats");
  assert.equal(phoneChatOffers(null).fileViews, false);
});
