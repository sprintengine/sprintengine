/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { describeTransport, readTransportDeclaration, withTransportDeclaration, withEnvironmentId } = require(
  path.join(buildRoot, "src/api/tailnetTransport.js"),
);

test("the version is read out of any gateway answer, and a missing or odd one is null, never 0", () => {
  // A desktop from before transport 3 also listed capabilities here; the phone keeps none of them.
  assert.deepEqual(readTransportDeclaration({ transportVersion: 3, capabilities: ["conversations"] }), { transportVersion: 3 });
  assert.deepEqual(readTransportDeclaration({ product: "SprintEngine Studio MCP", transportVersion: 1, protocolVersions: [] }), {
    transportVersion: 1,
  });
  assert.deepEqual(readTransportDeclaration({ transportVersion: "two" }), { transportVersion: null });
  assert.deepEqual(readTransportDeclaration({ transportVersion: 1.5 }), { transportVersion: null });
  assert.deepEqual(readTransportDeclaration(null), { transportVersion: null });
  assert.deepEqual(readTransportDeclaration([]), { transportVersion: null });
});

test("the transport line says the version, or that none was declared", () => {
  assert.equal(describeTransport({}), "tailnet, version not declared");
  assert.equal(describeTransport({ tailnetTransportVersion: 3 }), "tailnet v3");
});

test("folding a fresh version in returns null when nothing moved, so a foreground re-read writes nothing", () => {
  const session = { deviceId: "d", tailnetTransportVersion: 3 };
  assert.equal(withTransportDeclaration(session, { transportVersion: 3 }), null);
  // The gateway saying nothing keeps what the session has.
  assert.equal(withTransportDeclaration(session, { transportVersion: null }), null);
  assert.deepEqual(withTransportDeclaration({ deviceId: "d", tailnetTransportVersion: 2 }, { transportVersion: 3 }), session);
  // A session paired before the declaration existed gains one, and the original is untouched.
  const bare = { deviceId: "d" };
  assert.deepEqual(withTransportDeclaration(bare, { transportVersion: 3 }), session);
  assert.deepEqual(bare, { deviceId: "d" });
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
