/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

// What the phone offers in a desktop's chats, read from that desktop's Studio
// welcome and this pairing's grant there: nothing before it has said
// anything, and nothing from what it said at pairing time.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { phoneChatOffers } = require(path.join(buildRoot, "src/api/chatOffers.js"));

const welcome = ({ studio = ["conversations", "conversation-sessions", "session-controls", "chat-lifecycle"], chats = [], scopes = ["conversation:read", "conversation:operate"] } = {}) => ({
  capabilities: studio,
  conversation: { protocolVersion: 1, minProtocolVersion: 1, capabilities: chats },
  grant: { clientId: "tailnet:phone", name: "android-phone", owner: false, scopes, ceiling: "bypass" },
});

test("before the desktop has said anything, nothing is offered", () => {
  const offers = phoneChatOffers(null);
  assert.equal(offers.said, false);
  for (const [name, value] of Object.entries(offers)) assert.equal(value, false, name);
});

test("a pairing that may drive its chats is offered what the desktop serves, and only that", () => {
  const offers = phoneChatOffers(
    welcome({
      chats: [
        "conversation-models",
        "conversation-queued-sends",
        "conversation-steer-sends",
        "conversation-subagents",
        "conversation-stop-subagent",
        "conversation-images",
        "conversation-plans",
      ],
    }),
  );
  assert.equal(offers.said, true);
  assert.equal(offers.follow, true);
  assert.equal(offers.operate, true);
  assert.equal(offers.modelSwitch, true);
  assert.equal(offers.hostQueue, true);
  assert.equal(offers.hostQueueAttachments, false, "held words only, where the desktop holds no pictures with them");
  assert.equal(offers.steer, true);
  assert.equal(offers.subagents, true);
  assert.equal(offers.stopAgents, true);
  assert.equal(offers.stepPictures, true);
  assert.equal(offers.sentPictures, false);
  assert.equal(offers.plans, true);
  assert.equal(offers.manage, true, "the Studio keeps its chats' rest, and the grant reaches it");
  assert.equal(offers.downscale, false, "the Studio socket keeps a picture as it came");
});

test("a read-only pairing follows and reads, and is offered nothing that drives the chat", () => {
  const offers = phoneChatOffers(
    welcome({ scopes: ["conversation:read"], chats: ["conversation-models", "conversation-queued-sends", "conversation-images", "conversation-stop-subagent"] }),
  );
  assert.equal(offers.follow, true);
  assert.equal(offers.stepPictures, true);
  for (const name of ["operate", "modelSwitch", "hostQueue", "stopAgents", "manage", "attachFiles"]) assert.equal(offers[name], false, name);
});

test("a Studio without chats, or a grant without them, is not followed", () => {
  assert.equal(phoneChatOffers(welcome({ studio: [] })).follow, false);
  assert.equal(phoneChatOffers(welcome({ scopes: ["workspaces:read"] })).follow, false);
  // A Studio that keeps no rest offers no Settle, Mark unread or Snooze.
  assert.equal(phoneChatOffers(welcome({ studio: ["conversations", "conversation-sessions"] })).manage, false);
});
