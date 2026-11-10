/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const { createDeviceNotesStore, pruneChatsOpened, readStoredChatsOpened } = require(
  path.join(buildRoot, "src/storage/sessionStore.js"),
);

/** An in-memory stand-in for the keychain, so the store's contract can be pinned. */
function memoryAdapter(initial = {}) {
  const values = { ...initial };
  return {
    values,
    isAvailable: async () => true,
    getItem: async (key) => values[key] ?? null,
    setItem: async (key, value) => {
      values[key] = value;
    },
    deleteItem: async (key) => {
      delete values[key];
    },
  };
}

const UNAVAILABLE = {
  isAvailable: async () => false,
  getItem: async () => null,
  setItem: async () => undefined,
  deleteItem: async () => undefined,
};

test("when this phone last opened each chat survives a relaunch", async () => {
  const adapter = memoryAdapter();
  const store = createDeviceNotesStore(adapter);
  await store.getChatsOpened();
  await store.markChatOpened("chat:d1:maeve", 1000);
  await store.markChatOpened("chat:d1:tadhg", 2000);

  const reopened = createDeviceNotesStore(adapter);
  assert.deepEqual(await reopened.getChatsOpened(), { "chat:d1:maeve": 1000, "chat:d1:tadhg": 2000 });
});

test("opening a chat after a relaunch keeps what was stored before it, read or not", async () => {
  const adapter = memoryAdapter({ "multicode.mobile.threadsOpened.v1": JSON.stringify({ "chat:d1:maeve": 1000 }) });
  // No read first: the store must not replace the stored map with this run's.
  const store = createDeviceNotesStore(adapter);
  await store.markChatOpened("chat:d1:tadhg", 2000);

  const reopened = createDeviceNotesStore(adapter);
  assert.deepEqual(await reopened.getChatsOpened(), { "chat:d1:maeve": 1000, "chat:d1:tadhg": 2000 });
});

test("opening a chat is monotonic, so a clock that jumps back cannot un-see a row", async () => {
  const store = createDeviceNotesStore(memoryAdapter());
  await store.getChatsOpened();
  await store.markChatOpened("t1", 5000);
  const after = await store.markChatOpened("t1", 1000);
  assert.equal(after.t1, 5000);
});

test("a mark unread lowers an opened stamp, never raises one, and the lowered stamp survives a relaunch", async () => {
  const adapter = memoryAdapter({ "multicode.mobile.threadsOpened.v1": JSON.stringify({ t1: 5000, t2: 800 }) });
  // No read first: the stored stamp is the one lowered, not this run's empty cache.
  const store = createDeviceNotesStore(adapter);
  assert.equal((await store.rewindChatOpened("t1", 1000)).t1, 1000);
  assert.equal((await store.rewindChatOpened("t2", 1000)).t2, 800, "already earlier: left as it is");
  assert.equal("t3" in (await store.rewindChatOpened("t3", 1000)), false, "a chat never opened has nothing to lower");
  const reopened = createDeviceNotesStore(adapter);
  assert.deepEqual(await reopened.getChatsOpened(), { t1: 1000, t2: 800 });
});

test("a corrupt opened-chats value degrades to nothing seen, never to a crash", () => {
  assert.deepEqual(readStoredChatsOpened(null), {});
  assert.deepEqual(readStoredChatsOpened("{"), {});
  assert.deepEqual(readStoredChatsOpened("[1,2,3]"), {});
  // The worst case a bad entry may cause is a row drawing green once more than
  // it should, which is strictly better than a wedged list.
  assert.deepEqual(readStoredChatsOpened('{"a":1,"b":"soon","c":0,"d":-4}'), { a: 1 });
});

test("the opened-chats map is capped at the most recent 200, because a chat's key is never reused", () => {
  const entries = {};
  for (let index = 0; index < 250; index += 1) entries[`t${index}`] = index;
  const pruned = pruneChatsOpened(entries);
  assert.equal(Object.keys(pruned).length, 200);
  // The newest survive; the oldest fall off and simply draw their finished
  // state once more.
  assert.equal(pruned.t249, 249);
  assert.equal(pruned.t49, undefined);
});

test("read notices round-trip, and degrade to none", async () => {
  const adapter = memoryAdapter();
  const store = createDeviceNotesStore(adapter);
  assert.deepEqual(await store.getReadNoticeIds(), []);

  await store.saveReadNoticeIds(["a", "a", "b", ""]);

  const reopened = createDeviceNotesStore(adapter);
  // Duplicates collapse and blanks are dropped: an id cannot be read twice.
  assert.deepEqual(await reopened.getReadNoticeIds(), ["a", "b"]);
});

test("the retired push switch's stored value is deleted, and only it", async () => {
  const adapter = memoryAdapter({
    "multicode.mobile.needsMePush.v1": "true",
    "multicode.mobile.noticesRead.v1": JSON.stringify(["a"]),
  });
  const store = createDeviceNotesStore(adapter);
  await store.forgetRetiredNotes();
  assert.equal("multicode.mobile.needsMePush.v1" in adapter.values, false);
  assert.deepEqual(await store.getReadNoticeIds(), ["a"]);
  // Again, with nothing left to delete, and with no storage at all: neither throws.
  await store.forgetRetiredNotes();
  await createDeviceNotesStore(UNAVAILABLE).forgetRetiredNotes();
});

test("chats list newest first until a grouping is chosen, and the choice survives a relaunch", async () => {
  const adapter = memoryAdapter();
  const store = createDeviceNotesStore(adapter);
  assert.equal(await store.getChatGrouping(), "recent");

  await store.saveChatGrouping("date");
  assert.equal(await createDeviceNotesStore(adapter).getChatGrouping(), "date");
  assert.equal(adapter.values["multicode.mobile.chatGrouping.v1"], "date");

  await store.saveChatGrouping("project");
  assert.equal(await createDeviceNotesStore(adapter).getChatGrouping(), "project");

  await store.saveChatGrouping("recent");
  assert.equal(await createDeviceNotesStore(adapter).getChatGrouping(), "recent");
});

test("the old Group chats by project switch, left on, still reads as grouping by project", async () => {
  const on = memoryAdapter({ "multicode.mobile.groupChatsByProject.v1": "true" });
  assert.equal(await createDeviceNotesStore(on).getChatGrouping(), "project");
  const off = memoryAdapter({ "multicode.mobile.groupChatsByProject.v1": "false" });
  assert.equal(await createDeviceNotesStore(off).getChatGrouping(), "recent");

  // A choice made since wins over the old switch, and saving one retires it.
  const store = createDeviceNotesStore(on);
  await store.saveChatGrouping("date");
  assert.equal("multicode.mobile.groupChatsByProject.v1" in on.values, false);
  assert.equal(await createDeviceNotesStore(on).getChatGrouping(), "date");
  const both = memoryAdapter({
    "multicode.mobile.groupChatsByProject.v1": "true",
    "multicode.mobile.chatGrouping.v1": "recent",
  });
  assert.equal(await createDeviceNotesStore(both).getChatGrouping(), "recent");
});

test("an unreadable grouping reads as the old switch said, and no storage keeps the choice for the run", async () => {
  const garbled = memoryAdapter({ "multicode.mobile.chatGrouping.v1": "by-colour" });
  assert.equal(await createDeviceNotesStore(garbled).getChatGrouping(), "recent");
  const garbledOn = memoryAdapter({
    "multicode.mobile.chatGrouping.v1": "",
    "multicode.mobile.groupChatsByProject.v1": "true",
  });
  assert.equal(await createDeviceNotesStore(garbledOn).getChatGrouping(), "project");

  const store = createDeviceNotesStore(UNAVAILABLE);
  assert.equal(await store.getChatGrouping(), "recent");
  await store.saveChatGrouping("date");
  assert.equal(await store.getChatGrouping(), "date");
});

test("a message sent mid-turn queues until Steer is chosen, and the choice survives a relaunch", async () => {
  const adapter = memoryAdapter();
  const store = createDeviceNotesStore(adapter);
  assert.equal(await store.getFollowUpBehavior(), "queue", "never chosen is what the phone always did");

  await store.saveFollowUpBehavior("steer");
  assert.equal(await createDeviceNotesStore(adapter).getFollowUpBehavior(), "steer");

  await adapter.setItem("multicode.mobile.followUpBehavior.v1", "sideways");
  assert.equal(await createDeviceNotesStore(adapter).getFollowUpBehavior(), "queue", "an unknown value reads as Queue");
});

test("with storage unavailable the notes still apply for the session, they just do not survive it", async () => {
  const store = createDeviceNotesStore(UNAVAILABLE);
  await store.markChatOpened("t1", 1000);
  assert.deepEqual(await store.getChatsOpened(), { t1: 1000 });
  await store.saveReadNoticeIds(["a"]);
  assert.deepEqual(await store.getReadNoticeIds(), ["a"]);
});

test("chats marked while the opened-at map is being written are written by the next write, not one each", async () => {
  const adapter = memoryAdapter();
  const writes = [];
  const setItem = adapter.setItem;
  let release = null;
  adapter.setItem = async (key, value) => {
    writes.push(value);
    if (!release) await new Promise((resolve) => (release = resolve));
    return setItem(key, value);
  };
  const store = createDeviceNotesStore(adapter);
  await store.getChatsOpened();
  const marks = [store.markChatOpened("t0", 1000)];
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 1; index < 50; index += 1) marks.push(store.markChatOpened(`t${index}`, 1000 + index));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all(marks);
  assert.equal(writes.length, 2, "the first mark's write, then one for the other 49");
  assert.equal(Object.keys(JSON.parse(adapter.values["multicode.mobile.threadsOpened.v1"])).length, 50);
  // A mark after they have all landed is written on its own, and lands.
  await store.markChatOpened("late", 5000);
  assert.equal(writes.length, 3);
  assert.equal(JSON.parse(adapter.values["multicode.mobile.threadsOpened.v1"]).late, 5000);
});

test("a failed write of the opened-at map is retried by the next mark", async () => {
  const adapter = memoryAdapter();
  const setItem = adapter.setItem;
  let fail = true;
  adapter.setItem = async (key, value) => {
    if (fail) throw new Error("keychain busy");
    return setItem(key, value);
  };
  const store = createDeviceNotesStore(adapter);
  await assert.rejects(store.markChatOpened("t1", 1000), /keychain busy/);
  fail = false;
  await store.markChatOpened("t2", 2000);
  assert.deepEqual(JSON.parse(adapter.values["multicode.mobile.threadsOpened.v1"]), { t1: 1000, t2: 2000 });
});
