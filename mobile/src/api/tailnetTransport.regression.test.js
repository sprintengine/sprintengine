/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const {
  describeTransport,
  readTransportDeclaration,
  TAILNET_TRANSPORT_KNOWN,
  TAILNET_TRANSPORT_MIN,
  transportStanding,
  transportStandingSentence,
  withTransportDeclaration,
  withEnvironmentId,
} = require(path.join(buildRoot, "src/api/tailnetTransport.js"));

test("this build speaks transport 1 through 2", () => {
  assert.equal(TAILNET_TRANSPORT_MIN, 1);
  assert.equal(TAILNET_TRANSPORT_KNOWN, 2);
});

test("a declaration is read out of any gateway answer, and a missing field is null — never 0 and never []", () => {
  assert.deepEqual(readTransportDeclaration({ transportVersion: 2, capabilities: ["conversations", "conversation-models"] }), {
    transportVersion: 2,
    capabilities: ["conversations", "conversation-models"],
  });
  // A version-1 Studio: the version, no capabilities field.
  assert.deepEqual(readTransportDeclaration({ product: "SprintEngine Studio MCP", transportVersion: 1, protocolVersions: [] }), {
    transportVersion: 1,
    capabilities: null,
  });
  assert.deepEqual(readTransportDeclaration({ transportVersion: 2, capabilities: [] }), { transportVersion: 2, capabilities: [] });
  assert.deepEqual(readTransportDeclaration({ transportVersion: "two", capabilities: ["conversations", 3] }), { transportVersion: null, capabilities: ["conversations"] });
  assert.deepEqual(readTransportDeclaration({ transportVersion: 1.5 }), { transportVersion: null, capabilities: null });
  assert.deepEqual(readTransportDeclaration(null), { transportVersion: null, capabilities: null });
  assert.deepEqual(readTransportDeclaration([]), { transportVersion: null, capabilities: null });
});

test("the standing is a range check; an undeclared version is unknown, not old", () => {
  assert.equal(transportStanding({ tailnetTransportVersion: 1 }), "current");
  assert.equal(transportStanding({ tailnetTransportVersion: 2 }), "current");
  assert.equal(transportStanding({ tailnetTransportVersion: 0 }), "studio-older");
  assert.equal(transportStanding({ tailnetTransportVersion: 3 }), "app-older");
  assert.equal(transportStanding({}), "unknown");
});

test("out of step is one sentence naming the side to update; in step and unknown say nothing", () => {
  assert.match(transportStandingSentence("studio-older"), /Update Studio on the desktop/u);
  assert.match(transportStandingSentence("app-older"), /Update the app/u);
  assert.equal(transportStandingSentence("current"), null);
  assert.equal(transportStandingSentence("unknown"), null);
});

test("the transport line says the version and the capabilities, and tells 'declared none' from 'declared nothing'", () => {
  assert.equal(describeTransport({}), "tailnet, version not declared");
  assert.equal(describeTransport({ tailnetTransportVersion: 1 }), "tailnet v1");
  assert.equal(describeTransport({ tailnetTransportVersion: 2, tailnetCapabilities: [] }), "tailnet v2 · no extras");
  assert.equal(
    describeTransport({ tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] }),
    "tailnet v2 · conversations, conversation-models",
  );
});

test("folding a fresh declaration in returns null when nothing moved, so a foreground re-read writes nothing", () => {
  const session = { deviceId: "d", tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] };
  assert.equal(withTransportDeclaration(session, { transportVersion: 2, capabilities: ["conversations", "conversation-models"] }), null);
  // The gateway saying nothing about a field keeps what the session has.
  assert.equal(withTransportDeclaration(session, { transportVersion: null, capabilities: null }), null);
  assert.deepEqual(withTransportDeclaration(session, { transportVersion: 3, capabilities: ["conversations", "conversation-models"] }), {
    deviceId: "d",
    tailnetTransportVersion: 3,
    tailnetCapabilities: ["conversations", "conversation-models"],
  });
  assert.deepEqual(withTransportDeclaration(session, { transportVersion: 2, capabilities: ["conversations"] }), {
    deviceId: "d",
    tailnetTransportVersion: 2,
    tailnetCapabilities: ["conversations"],
  });
  // A session paired before the declaration existed gains one.
  assert.deepEqual(withTransportDeclaration({ deviceId: "d" }, { transportVersion: 2, capabilities: ["conversations"] }), {
    deviceId: "d",
    tailnetTransportVersion: 2,
    tailnetCapabilities: ["conversations"],
  });
  // ...and the original is untouched.
  assert.deepEqual(session, { deviceId: "d", tailnetTransportVersion: 2, tailnetCapabilities: ["conversations", "conversation-models"] });
});

test("a desktop's environment id is folded into its pairing when it is new, and kept when a later answer says none", () => {
  const paired = { deviceId: "d1", desktopName: "mac-mini" };
  const identified = withEnvironmentId(paired, "env-mini");
  assert.equal(identified.environmentId, "env-mini");
  assert.equal(withEnvironmentId(identified, "env-mini"), null);
  assert.equal(withEnvironmentId(identified, null), null, "a Studio that says none has not changed which it is");
  assert.equal(withEnvironmentId(identified, "env-other").environmentId, "env-other");
  assert.equal(withEnvironmentId(paired, null), null);
});
