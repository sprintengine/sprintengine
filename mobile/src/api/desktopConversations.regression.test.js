/* global __dirname, Buffer */
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

// The phone's chats on a paired desktop's Studio protocol: a chat followed as
// `conversation.session` and resumed by its cursor, its watches as push
// topics, every command a method under the phone's own id, the sends the
// phone holds, and its pictures and uploads. Each case drives the compiled
// module against a fake desktop that speaks the real frames
// (`fakeDesktopStudio`); only the phone's file module is stood in for.

const files = new Map();
const written = [];
Module._load = ((load) =>
  function (request, ...rest) {
    if (request === "expo-file-system/legacy")
      return {
        cacheDirectory: "file:///cache/",
        EncodingType: { Base64: "base64" },
        getInfoAsync: async (uri) =>
          files.has(uri) ? { exists: true, size: Buffer.from(files.get(uri), "base64").length } : { exists: false },
        readAsStringAsync: async (uri, options) =>
          Buffer.from(files.get(uri), "base64")
            .subarray(options.position, options.position + options.length)
            .toString("base64"),
        writeAsStringAsync: async (uri, data) => {
          files.set(uri, data);
          written.push(uri);
        },
        makeDirectoryAsync: async () => undefined,
      };
    return load.call(this, request, ...rest);
  })(Module._load);

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { createDesktopConversationsApi } = require(path.join(buildRoot, "src/api/desktopConversations.js"));
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

const key = { workspaceId: "workspace", agentId: "agent" };
const T0 = Date.UTC(2026, 10, 13, 9, 0);
const MINUTE = 60_000;
const ALL = [
  "conversation-queued-sends",
  "conversation-queued-attachments",
  "conversation-scheduled-sends",
  "conversation-subagents",
  "conversation-usage-limits",
  "conversation-steer-sends",
  "conversation-images",
  "conversation-message-images",
];
const event = (seq, type, payload = {}, at = T0) => ({
  id: `event-${seq}`,
  seq,
  type,
  sessionId: "session",
  ...key,
  providerId: "p",
  modelId: "m",
  createdAt: at,
  payload,
});
const snapshot = (events = [], extra = {}) => ({
  type: "snapshot",
  page: { events, hasMore: false, beforeCursor: null },
  generation: "g1",
  ...extra,
});
const fence = (seq, generation = "g1") => ({ type: "synchronized", seq, generation });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 3_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

let desktops = 0;
/**
 * A desktop of its own for each case, and a chat on it opened by the phone:
 * `answer` answers each method, `follow` the subscription.
 */
function fixture({ answer = () => ({}), follow, capabilities = ALL, scopes, now = () => T0, ...rest } = {}) {
  const desktop = fakeDesktopStudio({
    answer,
    conversationCapabilities: capabilities,
    follow: follow ?? (() => [snapshot(), fence(0)]),
    ...(scopes ? { scopes } : {}),
    ...rest,
  });
  const target = { baseUrl: `http://mac-mini-${++desktops}:4100`, deviceToken: "mctn_example" };
  const api = createDesktopConversationsApi(target, { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket, now });
  const states = [];
  const details = [];
  const frames = [];
  const started = [];
  const stale = [];
  const reheld = [];
  const waiting = [];
  const open = (options, afterSeq = 0) =>
    api.open(
      key,
      afterSeq,
      {
        onState: (state, detail) => {
          states.push(state);
          details.push(detail);
        },
        onFrame: (frame) => frames.push(frame),
        onSendStarted: (id) => started.push(id),
        onSendStale: (id) => stale.push(id),
        onSendHeld: (id, command, heldAfter) => reheld.push({ id, command, heldAfter }),
        onSendWaiting: (id) => waiting.push(id),
      },
      options,
    );
  const sent = (method) => desktop.requests.filter((request) => request.method === method);
  const answers = () => frames.filter((frame) => frame.type === "commandResult");
  return { desktop, api, states, details, frames, started, stale, reheld, waiting, open, sent, answers, target };
}
const live = (f) => until(() => f.states.at(-1) === "live", "the stream to be live");
const done = (stream) => {
  stream.close();
  closeDesktopStudios();
};

test("a chat is followed on conversation.session from its cached cursor, and resumed by the client after a drop", async () => {
  const f = fixture({
    follow: (_params, cursor) => (cursor ? [{ type: "event", event: event(6, "content_delta", { text: "b" }) }, fence(6)] : [snapshot(), fence(0)]),
  });
  const stream = f.open({ generation: "g1" }, 5);
  await live(f);
  assert.deepEqual(f.desktop.follows[0].cursor, { afterSeq: 5, generation: "g1" }, "the cached cursor, with its generation");
  assert.deepEqual(f.desktop.follows[0].params, { key, turnLimit: 10 });
  assert.deepEqual(
    f.frames.map((frame) => frame.type),
    ["event", "synchronized"],
    "only the missed events, then the fence: no snapshot",
  );
  // The socket drops (a backgrounded phone): the client makes it again and
  // follows from the fence it took, with nothing missed and nothing twice.
  f.desktop.cut();
  await until(() => f.desktop.follows.length === 2, "the resume");
  assert.deepEqual(f.desktop.follows[1].cursor, { afterSeq: 6, generation: "g1" });
  await live(f);
  assert.ok(f.states.includes("offline"), "said while it was down");
  assert.equal(f.frames.filter((frame) => frame.type === "event" && frame.event.seq === 6).length, 1, "the event once");
  done(stream);
});

test("without a cursor the chat opens on a snapshot; one from another log generation replaces what is held", async () => {
  const f = fixture({ follow: () => [snapshot([event(1, "user_message", { text: "hi", commandId: "c-1" })], { generation: "g2" }), fence(1, "g2")] });
  const stream = f.open({ generation: "g1" }, 0);
  await live(f);
  assert.equal(f.desktop.follows[0].cursor, undefined, "a cursor at nothing is no cursor");
  const opened = f.frames.find((frame) => frame.type === "snapshot");
  assert.equal(opened.reset, true, "another generation's log replaces the one held");
  done(stream);
});

test("each command is its own method under the phone's id, and its answer is handed on", async () => {
  const f = fixture({ answer: (method) => (method === "conversation.setModel" ? { modelId: "m2", notice: "From the next turn." } : {}) });
  const stream = f.open();
  await live(f);
  stream.command({ kind: "setModel", modelId: "m2" }, "c-model");
  stream.command({ kind: "resolveApproval", requestId: "r-1", decision: "once" }, "c-approve");
  stream.command({ kind: "interrupt" }, "c-stop");
  await until(() => f.answers().length === 3, "three answers");
  assert.deepEqual(f.sent("conversation.setModel")[0].params, { key, commandId: "c-model", modelId: "m2" });
  assert.deepEqual(f.sent("conversation.resolveApproval")[0].params, {
    key,
    commandId: "c-approve",
    requestId: "r-1",
    decision: "once",
  });
  assert.deepEqual(f.sent("conversation.interrupt")[0].params, { key, commandId: "c-stop" });
  assert.deepEqual(
    f.answers().find((frame) => frame.commandId === "c-model"),
    { type: "commandResult", commandId: "c-model", ok: true, modelId: "m2", notice: "From the next turn." },
  );
  done(stream);
});

test("a refused command comes back with the desktop's code and words", async () => {
  const f = fixture({
    answer: () => ({ error: { code: "ceiling_exceeded", message: "This app may not allow that for the conversation." } }),
  });
  const stream = f.open();
  await live(f);
  stream.command({ kind: "resolveApproval", requestId: "r", decision: "conversation" }, "c-1");
  await until(() => f.answers().length === 1, "the refusal");
  assert.deepEqual(f.answers()[0], {
    type: "commandResult",
    commandId: "c-1",
    ok: false,
    code: "ceiling_exceeded",
    message: "This app may not allow that for the conversation.",
  });
  done(stream);
});

test("sends go one at a time: the next waits for the turn the last began to end", async () => {
  const f = fixture({ answer: () => ({}) });
  const stream = f.open();
  await live(f);
  stream.command({ kind: "send", message: "first" }, "s-1");
  await until(() => f.sent("conversation.send").length === 1, "the first send");
  // The desktop answers when the turn ends; the second goes after that.
  stream.command({ kind: "send", message: "second" }, "s-2");
  f.desktop.frame({ type: "event", key, event: event(1, "user_message", { text: "first", commandId: "s-1" }) });
  await until(() => f.frames.some((frame) => frame.type === "event"), "the user message");
  f.desktop.frame({ type: "event", key, event: event(2, "turn_completed", {}) });
  await until(() => f.sent("conversation.send").length === 2, "the second send");
  assert.deepEqual(f.started, ["s-1", "s-2"]);
  assert.equal(f.sent("conversation.send")[1].params.message, "second");
  done(stream);
});

test("a send made behind a running turn is handed to a desktop that holds messages, with its uploads", async () => {
  const f = fixture({ follow: () => [snapshot([event(1, "turn_started", {})]), fence(1)] });
  const stream = f.open({ initiallyBusy: true });
  await live(f);
  stream.command({ kind: "send", message: "and then this", uploadIds: ["u-1"] }, "s-1");
  await until(() => f.sent("conversation.send").length === 1, "the hand-over");
  assert.deepEqual(f.sent("conversation.send")[0].params, {
    key,
    commandId: "s-1",
    message: "and then this",
    uploadIds: ["u-1"],
    queue: true,
  });
  assert.deepEqual(f.reheld.map((entry) => entry.id), ["s-1"]);
  done(stream);
});

test("where the desktop holds nothing, a send waits on the phone for the turn to end", async () => {
  const f = fixture({ capabilities: [], follow: () => [snapshot([event(1, "turn_started", {})]), fence(1)] });
  const stream = f.open({ initiallyBusy: true });
  await live(f);
  stream.command({ kind: "send", message: "later" }, "s-1");
  await sleep(30);
  assert.equal(f.sent("conversation.send").length, 0, "nothing goes while the turn runs");
  f.desktop.frame({ type: "event", key, event: event(2, "turn_completed", {}) });
  await until(() => f.sent("conversation.send").length === 1, "the send after the turn");
  assert.equal(f.sent("conversation.send")[0].params.queue, undefined);
  done(stream);
});

test("a send the desktop turns away busy is handed over to be held, once", async () => {
  let sends = 0;
  const f = fixture({
    answer: (method, params) =>
      method === "conversation.send" && !params.queue && ++sends > 0
        ? { error: { code: "busy", message: "A turn is running.", retryAfterMs: 5 } }
        : {},
  });
  const stream = f.open();
  await live(f);
  stream.command({ kind: "send", message: "now" }, "s-1");
  await until(() => f.sent("conversation.send").some((request) => request.params.queue === true), "the hand-over", 5_000);
  const held = f.sent("conversation.send").filter((request) => request.params.queue === true);
  assert.equal(held.length, 1);
  assert.equal(held[0].params.commandId, "s-1", "the same id, so the desktop holds it once");
  done(stream);
});

test("a steer goes into the running turn at once, never behind it", async () => {
  const f = fixture({ follow: () => [snapshot([event(1, "turn_started", {})]), fence(1)] });
  const stream = f.open({ initiallyBusy: true });
  await live(f);
  stream.command({ kind: "send", message: "and add tests", steer: true }, "st-1");
  await until(() => f.sent("conversation.send").length === 1, "the steer");
  assert.equal(f.sent("conversation.send")[0].params.steer, true);
  assert.deepEqual(f.started, ["st-1"]);
  done(stream);
});

test("a send carried across an absence too long is handed back as not sent, never offered", async () => {
  const f = fixture({ now: () => T0 + 60 * MINUTE });
  const stream = f.open({ pendingSends: [{ commandId: "old", command: { kind: "send", message: "old" }, queuedAt: T0 }] });
  await live(f);
  await until(() => f.stale.length === 1, "the stale send");
  assert.deepEqual(f.stale, ["old"]);
  assert.equal(f.sent("conversation.send").length, 0);
  done(stream);
});

test("a carried send whose turn ended while the phone was away is not offered either", async () => {
  const f = fixture({
    now: () => T0 + MINUTE,
    follow: () => [
      { type: "event", event: event(4, "turn_started", {}, T0 + 10_000) },
      { type: "event", event: event(5, "turn_completed", {}, T0 + 20_000) },
      fence(5),
    ],
  });
  const stream = f.open(
    { generation: "g1", pendingSends: [{ commandId: "c", command: { kind: "send", message: "when you're done" }, queuedAt: T0 }] },
    3,
  );
  await live(f);
  assert.deepEqual(f.stale, ["c"]);
  assert.equal(f.sent("conversation.send").length, 0);
  done(stream);
});

test("a carried hand-over the chat shows the desktop already sent is settled, and never offered again", async () => {
  const f = fixture({
    now: () => T0 + MINUTE,
    follow: () => [{ type: "event", event: event(8, "user_message", { text: "draft the phone side", commandId: "desktop-join" }) }, fence(8)],
  });
  const stream = f.open(
    {
      generation: "g1",
      pendingSends: [
        { commandId: "h-1", command: { kind: "send", message: "draft the phone side", queue: true }, heldAfter: 7, queuedAt: T0 },
      ],
    },
    7,
  );
  await live(f);
  await until(() => f.answers().some((frame) => frame.commandId === "h-1"), "the settled hand-over");
  assert.deepEqual(f.answers().find((frame) => frame.commandId === "h-1"), { type: "commandResult", commandId: "h-1", ok: true });
  assert.equal(f.sent("conversation.send").length, 0);
  done(stream);
});

test("a send queued while the desktop is out of reach goes once it answers", async () => {
  let up = false;
  const f = fixture({ ticketStatus: () => (up ? 200 : 503) });
  const stream = f.open();
  await until(() => f.states.includes("offline"), "offline");
  stream.command({ kind: "send", message: "while away" }, "s-away");
  up = true;
  stream.foreground(5 * 1_000);
  await live(f);
  await until(() => f.sent("conversation.send").length === 1, "the send");
  assert.equal(f.sent("conversation.send")[0].params.commandId, "s-away");
  done(stream);
});

test("the chat's watches are subscribed where the desktop serves them, and another chat's frame is dropped", async () => {
  const f = fixture({ capabilities: ["conversation-queued-sends", "conversation-subagents"] });
  const stream = f.open();
  await live(f);
  await until(() => f.desktop.subscriptions.size === 3, "the watches");
  assert.deepEqual([...f.desktop.subscriptions.values()].sort(), [
    "conversation.queued",
    "conversation.session",
    "conversation.subagents",
  ]);
  f.desktop.push("conversation.queued", { type: "queued", key: { workspaceId: "other", agentId: "agent" }, messages: [] });
  f.desktop.push("conversation.queued", { type: "queued", key, messages: [{ id: "q", text: "held", createdAt: 1 }] });
  await until(() => f.frames.some((frame) => frame.type === "queued"), "the queued frame");
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === "queued").map((frame) => frame.key.workspaceId),
    ["workspace"],
  );
  done(stream);
});

test("reads are the chat's methods, answered with ok beside their result", async () => {
  const f = fixture({
    answer: (method) =>
      method === "conversation.loadEarlier"
        ? { page: { events: [], hasMore: false, beforeCursor: null } }
        : method === "conversation.toolDetail"
          ? { detail: { input: {}, output: "done", status: "ok", clipped: false } }
          : { error: { code: "not_found", message: "That turn kept no checkpoint." } },
  });
  const stream = f.open();
  await live(f);
  const page = await stream.read({ type: "loadEarlier", beforeCursor: 40 });
  assert.deepEqual(page, { ok: true, page: { events: [], hasMore: false, beforeCursor: null } });
  assert.deepEqual(f.sent("conversation.loadEarlier")[0].params, { key, beforeCursor: 40, turnLimit: 10 });
  const detail = await stream.read({ type: "getToolDetail", toolUseId: "tool-1" });
  assert.equal(detail.detail.output, "done");
  await assert.rejects(stream.read({ type: "getTurnDiff", turnSeq: 3 }), /kept no checkpoint/);
  done(stream);
});

test("a revoked pairing stops the chat as revoked, and a grant without the chat as blocked", async () => {
  const revoked = fixture({ ticketStatus: () => 401 });
  const one = revoked.open();
  await until(() => revoked.states.includes("revoked"), "revoked");
  assert.equal(revoked.desktop.follows.length, 0);
  done(one);

  const narrowed = fixture();
  const two = narrowed.open();
  await live(narrowed);
  narrowed.desktop.refuseFollows({ code: "scope_required", message: "This app's grant does not include conversation:read.", retryable: false });
  await until(() => narrowed.states.at(-1) === "blocked", "blocked");
  done(two);
});

test("a chat the desktop no longer has stops as unavailable until retry", async () => {
  const f = fixture();
  const stream = f.open();
  await live(f);
  f.desktop.refuseFollows({ code: "not_found", message: "No such conversation.", retryable: false });
  await until(() => f.states.at(-1) === "unavailable", "unavailable");
  stream.retry();
  await live(f);
  assert.equal(f.desktop.follows.length, 2, "followed again on retry");
  done(stream);
});

test("an upload is begun with its size and sent in the pieces the desktop names, read from the file as it goes", async () => {
  files.set("file:///photo.jpg", Buffer.alloc(1_300, 7).toString("base64"));
  const f = fixture({
    answer: (method, params) =>
      method === "uploads.begin" ? { uploadId: "u-9", chunkBytes: 512 } : { received: params.offset + Buffer.from(params.dataBase64, "base64").length },
  });
  const id = await f.api.uploadImage({ uri: "file:///photo.jpg", name: "photo.jpg", mediaType: "image/jpeg" });
  assert.equal(id, "u-9");
  assert.deepEqual(f.sent("uploads.begin")[0].params, {
    mediaType: "image/jpeg",
    byteLength: 1_300,
    name: "photo.jpg",
    purpose: "picture",
  });
  assert.deepEqual(
    f.sent("uploads.append").map((request) => [request.params.offset, Buffer.from(request.params.dataBase64, "base64").length]),
    [
      [0, 512],
      [512, 512],
      [1_024, 276],
    ],
  );
  files.set("file:///notes.pdf", Buffer.from("pdf").toString("base64"));
  await f.api.uploadFile({ uri: "file:///notes.pdf", name: "notes.pdf", mediaType: "application/pdf" });
  assert.equal(f.sent("uploads.begin")[1].params.purpose, "attachment");
  closeDesktopStudios();
});

test("a chat's picture is read once into the phone's cache, and from there after that", async () => {
  const f = fixture({
    answer: (method, params) =>
      method === "conversation.picture"
        ? params.toolUseId === "gone"
          ? { error: { code: "not_found", message: "That picture is not in this conversation." } }
          : { mediaType: "image/png", dataBase64: Buffer.from("png").toString("base64") }
        : {},
  });
  const first = await f.api.picture({ ...key, toolUseId: "tool-1" });
  assert.equal(first.ok, true);
  assert.match(first.uri, /^file:\/\/\/cache\/chat-pictures\/[0-9a-f]{16}\.png$/u);
  const again = await f.api.picture({ ...key, toolUseId: "tool-1" });
  assert.equal(again.uri, first.uri);
  assert.equal(f.sent("conversation.picture").length, 1, "never read twice");
  assert.deepEqual(f.sent("conversation.picture")[0].params, { key, toolUseId: "tool-1" });
  const sentPicture = await f.api.picture({ ...key, attachment: "ref-1" });
  assert.notEqual(sentPicture.uri, first.uri);
  assert.deepEqual(f.sent("conversation.picture")[1].params, { key, attachment: "ref-1" });
  assert.deepEqual(await f.api.picture({ ...key, toolUseId: "gone" }), { ok: false, problem: "gone" });
  closeDesktopStudios();
});
