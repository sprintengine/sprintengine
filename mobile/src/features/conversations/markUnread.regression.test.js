/* global __dirname */
// Mark unread, synced with the desktop: where the phone offers it, the
// desktop's `conversation.markUnread` (its call is chatLifecycle's, and its
// suite's), and how a visit clock the
// desktop moved back is read against this phone's own readings: the list's
// green, the bell's, and the "New" divider.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build/mobile");
const {
  listedVisitRewind,
  markUnreadOffered,
  visitRewindApplies,
  withVisitRewind,
} = require(path.join(buildRoot, "src/features/conversations/chatLifecycleLogic.js"));
const { buildChatRows, chatMarkedUnread, chatRowState, chatSeenAt, chatSections } = require(
  path.join(buildRoot, "src/features/conversations/conversationListLogic.js"),
);
const { chatOpenedSince, unreadDividerRowId, unreadDividerTurn } = require(
  path.join(buildRoot, "src/features/conversations/unreadDivider.js"),
);
const { projectPhoneConversation } = require(path.join(buildRoot, "src/features/conversations/conversationLogic.js"));
const { buildNotices } = require(path.join(buildRoot, "src/features/notices/noticesLogic.js"));
const { decodeConversationServerFrame: parseConversationFrame } = require(path.join(buildRoot, "../packages/conversation-protocol/src/public.js"));
// A listed chat as the phone reads it: through a `sessions` frame, by the
// desktop's contract.
const ROW = { workspaceId: "w", agentId: "a", title: "t", phase: "idle", updatedAt: 1, createdAt: 1, providerId: "p", modelId: "m", turnCount: 0, lastSeq: 0 };
const readRow = (fields) =>
  parseConversationFrame(JSON.stringify({ type: "sessions", requestId: "r", sessions: [{ ...ROW, ...fields }] })).sessions[0];
const LIFECYCLE = ["chatTitle", "lastUserMessageAt", "lastTurnEndedAt", "lastVisitedAt", "visitRewoundAt", "snoozedUntil"];
const lifecycleOf = (fields) => {
  const row = readRow(fields);
  return Object.fromEntries(LIFECYCLE.filter((name) => name in row).map((name) => [name, row[name]]));
};


const NOW = 1_800_000_000_000;
const MIN = 60_000;

const thread = (overrides = {}) => ({
  workspaceId: "w1",
  agentId: "a1",
  title: "Chat",
  phase: "completed",
  updatedAt: NOW - 10 * MIN,
  createdAt: NOW - 60 * MIN,
  providerId: "claude-code",
  lastTurnEndedAt: NOW - 10 * MIN,
  lastVisitedAt: NOW - 5 * MIN,
  ...overrides,
});
const rows = (input) =>
  buildChatRows({ deviceId: "mac", desktopName: "Mac", workspaces: null, manage: true, ...input });

test("Mark unread is offered only where the desktop keeps its chats' rest and this phone operates its chats", () => {
  const [offered] = rows({ threads: [thread()] });
  assert.equal(offered.canMarkUnread, true);
  assert.equal(markUnreadOffered(offered, { now: NOW }), true);
  // A Studio that keeps no rest, or a grant that does not reach it (a
  // pairing that may only read its chats), marks nothing.
  const [unmanaged] = rows({ threads: [thread()], manage: false });
  assert.equal(unmanaged.canMarkUnread, false);
  assert.equal(markUnreadOffered(unmanaged, { now: NOW }), false);
});

test("Mark unread waits for a finished reply, and is not offered on a chat already unread", () => {
  const [nothingFinished] = rows({ threads: [thread({ lastTurnEndedAt: undefined, phase: "running" })]});
  assert.equal(markUnreadOffered(nothingFinished, { now: NOW }), false, "the desktop would refuse it as nothing_finished");
  // Working on its next turn, with an earlier one finished and read: offered.
  const [working] = rows({ threads: [thread({ phase: "running" })]});
  assert.equal(markUnreadOffered(working, { now: NOW }), true);
  // Finished after anyone last looked: it is green already.
  const [unseen] = rows({ threads: [thread({ lastVisitedAt: NOW - 20 * MIN })]});
  assert.equal(markUnreadOffered(unseen, { now: NOW }), false);
  // The phone opened it after the finish: read here, so offered.
  assert.equal(markUnreadOffered(unseen, { now: NOW, openedAt: NOW - MIN }), true);
});

test("a listed visitRewoundAt is kept in its shape, beside the visit clock", () => {
  assert.deepEqual(lifecycleOf({ lastVisitedAt: 10, visitRewoundAt: 20 }), { lastVisitedAt: 10, visitRewoundAt: 20 });
  assert.deepEqual(lifecycleOf({ lastVisitedAt: 10, visitRewoundAt: "20" }), { lastVisitedAt: 10 });
});

test("a list read shows a mark unread made elsewhere: a listed stamp, or a clock gone back on a desktop that takes the tool", () => {
  const read = (overrides) =>
    listedVisitRewind({ thread: {}, previousVisitedAt: null, readStartedAt: NOW, markUnread: true, ...overrides });
  // The desktop lists the mark's own time: that is the mark.
  assert.deepEqual(read({ thread: { lastVisitedAt: 100, visitRewoundAt: 500 } }), { visitedAt: 100, rewoundAt: 500 });
  // It lists only the clock: gone back since the last read is a mark, timed by the read.
  assert.deepEqual(read({ thread: { lastVisitedAt: 100 }, previousVisitedAt: 300 }), { visitedAt: 100, rewoundAt: NOW });
  assert.equal(read({ thread: { lastVisitedAt: 300 }, previousVisitedAt: 300 }), null, "unchanged");
  assert.equal(read({ thread: { lastVisitedAt: 400 }, previousVisitedAt: 300 }), null, "a visit moves it forward");
  assert.equal(read({ thread: { lastVisitedAt: 100 } }), null, "a clock never listed before says nothing");
  // A desktop without the tool moves its clock only forward, as it always did.
  assert.equal(read({ thread: { lastVisitedAt: 100 }, previousVisitedAt: 300, markUnread: false }), null);
  assert.equal(read({ thread: {}, previousVisitedAt: 300 }), null, "no clock listed, nothing to read");
});

test("a mark unread newer than this phone's own visit reading resets it; an older one leaves it", () => {
  const rewind = { visitedAt: NOW - 10 * MIN - 1, rewoundAt: NOW - 2 * MIN };
  // Opened four minutes ago, before the mark: the opening is reset to the desktop's clock.
  assert.equal(visitRewindApplies(rewind, NOW - 4 * MIN), true);
  // Opened a minute ago, after the mark: read again, and it stands.
  assert.equal(visitRewindApplies(rewind, NOW - MIN), false);
  // A reading at or before the rewound clock hides nothing.
  assert.equal(visitRewindApplies(rewind, rewind.visitedAt), false);
  assert.equal(visitRewindApplies(rewind, null), false);

  // The list's green follows: the turn that ended ten minutes ago is unseen
  // again over an opening from before the mark, and read over one after it.
  const listed = withVisitRewind(thread({ lastVisitedAt: NOW - 5 * MIN }), rewind);
  assert.equal(listed.lastVisitedAt, rewind.visitedAt, "a clock read before the mark shows the mark's");
  assert.equal(listed.visitRewoundAt, rewind.rewoundAt);
  const state = (openedAt) => chatRowState(listed, { now: NOW, openedAt });
  assert.equal(state(NOW - 4 * MIN), "finished");
  assert.equal(state(NOW - MIN), "idle");
  assert.equal(chatSeenAt(listed, NOW - 4 * MIN), rewind.visitedAt);

  // A visit stamped since the mark is the chat read again, and is kept.
  const visitedSince = withVisitRewind(thread({ lastVisitedAt: NOW - MIN }), rewind);
  assert.equal(visitedSince.lastVisitedAt, NOW - MIN);
  assert.equal(chatRowState(visitedSince, { now: NOW, openedAt: NOW - 4 * MIN }), "idle");

  // Without a mark, the later of the two readings, as before.
  assert.equal(chatSeenAt(thread({ lastVisitedAt: NOW - 20 * MIN }), NOW - 4 * MIN), NOW - 4 * MIN);
  assert.equal(withVisitRewind(thread(), null).lastVisitedAt, NOW - 5 * MIN);
});

test("after a mark unread the next opening's divider sits above the latest reply", () => {
  let sequence = 0;
  const event = (type, createdAt, payload = {}) => {
    sequence += 1;
    return { id: `e${sequence}`, seq: sequence, sessionId: "s", workspaceId: "w1", agentId: "a1", createdAt, type, payload };
  };
  const exchange = (turnId, start, end) => [
    event("user_message", start, { turnId, text: `ask ${turnId}` }),
    event("turn_started", start, { turnId }),
    event("content_delta", start + 1, { turnId, text: `answer ${turnId}` }),
    event("turn_completed", end, { turnId, durationMs: end - start }),
  ];
  const events = [...exchange("t1", 100, 110), ...exchange("t2", 200, 210)];
  const projected = projectPhoneConversation(events);
  const divider = (opened) => unreadDividerRowId(projected.rows, unreadDividerTurn(projected.replies, opened));

  // Read after both: no divider.
  const before = { lastVisitedAt: 500 };
  assert.equal(divider(chatOpenedSince([before, before], 1_000)), null);

  // Marked unread: the clock goes back to just before t2's finish. The thread
  // the chat was handed before the mark still has 500; the list's has the mark.
  const marked = { lastVisitedAt: 209, visitRewoundAt: 600 };
  const opened = chatOpenedSince([before, marked], 1_000);
  assert.equal(opened.seenAt, 209, "the mark wins over a reading from before it");
  assert.deepEqual(chatOpenedSince([marked, before], 1_000), opened, "whichever thread it rides in");
  const id = divider(opened);
  assert.ok(id, "a divider is drawn");
  const row = projected.rows.find((entry) => entry.id === id);
  assert.equal(row.turn ?? row.lane?.turn, "t2", "above the latest reply");

  // A visit since the mark wins over it again.
  assert.equal(chatOpenedSince([marked, { lastVisitedAt: 700 }], 1_000).seenAt, 700);
  assert.equal(divider(chatOpenedSince([marked, { lastVisitedAt: 700 }], 1_000)), null);
});

test("a chat marked unread shows unread at any age: green under Earlier, where it stays, and no longer offered", () => {
  const DAY = 24 * 60 * MIN;
  // Finished three days ago, read a minute later, and written in no sooner.
  const old = thread({
    updatedAt: NOW - 3 * DAY,
    createdAt: NOW - 4 * DAY,
    lastUserMessageAt: NOW - 3 * DAY - 5 * MIN,
    lastTurnEndedAt: NOW - 3 * DAY,
    lastVisitedAt: NOW - 3 * DAY + MIN,
  });
  const [before] = rows({ threads: [old]});
  assert.equal(chatRowState(before.thread, { now: NOW }), "idle");
  assert.equal(markUnreadOffered(before, { now: NOW }), true);

  // Marked just now: the clock goes back to just before that finish.
  const rewind = { visitedAt: NOW - 3 * DAY - 1, rewoundAt: NOW - MIN };
  const opened = NOW - 3 * DAY + 2 * MIN;
  for (const marked of [
    // This phone's own mark, or one it inferred from the clock going back.
    withVisitRewind(old, rewind),
    // The desktop's, listed.
    { ...old, lastVisitedAt: rewind.visitedAt, visitRewoundAt: rewind.rewoundAt },
  ]) {
    const [row] = rows({ threads: [marked]});
    assert.equal(chatMarkedUnread(row.thread, opened), true);
    assert.equal(chatRowState(row.thread, { now: NOW, openedAt: opened }), "finished", "the mark is seen, however old the turn");
    assert.equal(markUnreadOffered(row, { now: NOW, openedAt: opened }), false, "it is unread already");
    // A state tints a row and never moves it: still under Earlier.
    const { recent, earlier } = chatSections([row], NOW);
    assert.deepEqual([recent.length, earlier.length], [0, 1]);
    // The bell keeps its day: an old finish is not news, marked or not.
    assert.deepEqual(buildNotices({ chats: [row], openedAt: {}, now: NOW }), []);

    // Opening it, the divider goes above the reply the mark made new: the
    // clock it is read against is the mark's, before that finish.
    const seen = chatOpenedSince([old, row.thread], NOW).seenAt;
    assert.equal(seen, rewind.visitedAt);
    assert.ok(seen < old.lastTurnEndedAt);
    // And the opening reads it: the mark is gone, and Mark unread is back.
    const [read] = rows({ threads: [row.thread]});
    assert.equal(chatMarkedUnread(read.thread, NOW), false);
    assert.equal(chatRowState(read.thread, { now: NOW, openedAt: NOW }), "idle");
    assert.equal(markUnreadOffered(read, { now: NOW, openedAt: NOW }), true);
    // As does a visit stamped anywhere since the mark.
    assert.equal(chatRowState({ ...row.thread, lastVisitedAt: NOW }, { now: NOW }), "idle");
  }
});

test("without a mark, a finish nobody saw still goes quiet after a day", () => {
  const DAY = 24 * 60 * MIN;
  const unseen = thread({ updatedAt: NOW - 2 * DAY, lastTurnEndedAt: NOW - 2 * DAY, lastVisitedAt: NOW - 3 * DAY });
  assert.equal(chatRowState(unseen, { now: NOW }), "idle");
  // An old mark the person has since read past does not keep a later finish green.
  const readSince = { ...unseen, visitRewoundAt: NOW - 4 * DAY, lastVisitedAt: NOW - 3 * DAY };
  assert.equal(chatMarkedUnread(readSince), false);
  assert.equal(chatRowState(readSince, { now: NOW }), "idle");
  // Within the day a marked chat rings the bell as any unseen finish does.
  const [recent] = rows({ threads: [thread({ lastVisitedAt: NOW - 10 * MIN - 1, visitRewoundAt: NOW - MIN })]});
  assert.equal(buildNotices({ chats: [recent], openedAt: {}, now: NOW }).length, 1);
});
