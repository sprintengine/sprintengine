/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build/mobile");
const { openForWords, tabMetaWords, tabTitle } = require(path.join(buildRoot, "src/features/settings/browserTabsLogic.js"));

const HOUR = 60 * 60_000;

test("a tab's line leads with its sound, then whether it is on screen, then how long it has been open", () => {
  const now = Date.UTC(2026, 10, 24);
  assert.equal(tabMetaWords({ audible: true, inView: false, openedAt: now - 7 * 24 * HOUR }, now), "Playing sound · open 7 days");
  assert.equal(tabMetaWords({ audible: false, inView: true, openedAt: now - 3 * HOUR }, now), "On screen · open 3 hours");
  assert.equal(openForWords(20_000), "1 minute");
});

test("a tab is named by its title, else its address's host", () => {
  assert.equal(tabTitle({ title: " Game ", url: "http://localhost:5173/" }), "Game");
  assert.equal(tabTitle({ title: "", url: "http://localhost:5173/x" }), "localhost:5173");
  assert.equal(tabTitle({ title: "", url: "not a url" }), "not a url");
});
