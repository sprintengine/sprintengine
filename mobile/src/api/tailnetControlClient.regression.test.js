/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const {
  completeTailnetPairing,
  readTailnetIdentity,
  withTailnetScopes,
} = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
const { parsePairingPayload, tailnetEndpointBaseUrl } = require(path.join(
  buildRoot,
  "src/features/pairing/pairingPayload.js",
));
const { createMobileSessionFromTailnetPairing } = require(path.join(
  buildRoot,
  "src/features/pairing/pairingSession.js",
));

const originalFetch = global.fetch;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("the desktop's tailnet pairing link parses to its endpoint and one-time code", () => {
  // Exactly what tailnet-service.ts mints: two params, endpoint + token.
  const parsed = parsePairingPayload(
    "sprintengine-tailnet://pair?endpoint=100.101.102.103%3A8471&token=mcpair_abc123",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tailnet.endpoint, "100.101.102.103:8471");
  assert.equal(parsed.tailnet.baseUrl, "http://100.101.102.103:8471");
  assert.equal(parsed.tailnet.pairingToken, "mcpair_abc123");

  // Bracketed IPv6 survives the round trip.
  const v6 = parsePairingPayload(
    "sprintengine-tailnet://pair?endpoint=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A8471&token=mcpair_v6",
  );
  assert.equal(v6.ok, true);
  assert.equal(v6.tailnet.baseUrl, "http://[fd7a:115c:a1e0::1]:8471");

  // Missing halves are named, not guessed.
  assert.equal(parsePairingPayload("sprintengine-tailnet://pair?token=mcpair_x").ok, false);
  assert.equal(parsePairingPayload("sprintengine-tailnet://pair?endpoint=host%3A1").ok, false);
});

test("tailnet endpoints are host:port only — smuggled paths, credentials, and queries are refused", () => {
  assert.equal(tailnetEndpointBaseUrl("100.64.0.9:8471"), "http://100.64.0.9:8471");
  assert.equal(tailnetEndpointBaseUrl("studio.tail1234.ts.net:8471"), "http://studio.tail1234.ts.net:8471");
  assert.equal(tailnetEndpointBaseUrl("host:8471/evil/path"), null);
  assert.equal(tailnetEndpointBaseUrl("user:pass@host:8471"), null);
  assert.equal(tailnetEndpointBaseUrl("host:8471?x=1"), null);
  assert.equal(tailnetEndpointBaseUrl(""), null);
});

test("tailnet pairing exchanges the one-time code and stores the gateway's own grant", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return jsonResponse(200, {
      deviceId: "tnd_phone1",
      deviceName: "Test phone",
      deviceToken: "mctn_secret",
      scopes: ["workspace:read", "workspace:operate", "horizon:read"],
    });
  };
  try {
    const result = await completeTailnetPairing({
      baseUrl: "http://100.64.0.9:8471",
      pairingToken: "mcpair_abc",
      deviceName: "Test phone",
    });
    assert.equal(result.ok, true);
    assert.equal(requests[0].url, "http://100.64.0.9:8471/tailnet/v1/pair");
    assert.deepEqual(requests[0].body, { pairingToken: "mcpair_abc", deviceName: "Test phone" });

    const session = createMobileSessionFromTailnetPairing({
      tailnet: { endpoint: "100.64.0.9:8471", baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc" },
      completion: result.data,
      pairedAt: "2026-08-31T12:00:00.000Z",
    });
    assert.equal(session.baseUrl, "http://100.64.0.9:8471");
    assert.equal(session.deviceToken, "mctn_secret");
    assert.equal(session.deviceId, "tnd_phone1");
    // A Studio that declares nothing on the pair answer reads as "not declared", never as version 0.
    assert.deepEqual(result.data.transport, { transportVersion: null });
    assert.equal(session.tailnetTransportVersion, undefined);
    // The grant is kept as the gateway said it; `tailnetGrantAllows` decides
    // what it unlocks.
    assert.deepEqual(session.tailnetScopes, ["workspace:read", "workspace:operate", "horizon:read"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a Studio's pair answer lands its transport version on the session, and a capability list it sent is not kept", async () => {
  global.fetch = async () =>
    jsonResponse(200, {
      deviceId: "tnd_phone2",
      deviceName: "Test phone",
      deviceToken: "mctn_secret",
      scopes: ["workspace:read", "conversation:operate"],
      transportVersion: 3,
      // A desktop from before transport 3 listed capabilities here; what one serves is its Studio welcome's to say.
      capabilities: ["conversations", "conversation-models"],
    });
  try {
    const result = await completeTailnetPairing({ baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc", deviceName: "Test phone" });
    assert.equal(result.ok, true);
    const session = createMobileSessionFromTailnetPairing({
      tailnet: { endpoint: "100.64.0.9:8471", baseUrl: "http://100.64.0.9:8471", pairingToken: "mcpair_abc" },
      completion: result.data,
      pairedAt: "2026-09-06T12:00:00.000Z",
    });
    assert.equal(session.tailnetTransportVersion, 3);
    assert.equal("tailnetCapabilities" in session, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("readTailnetIdentity carries the bearer token, keeps the declaration, and reads a 401 as the pairing being gone", async () => {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, {
      deviceId: "tnd_phone1",
      deviceName: "Test phone",
      scopes: ["conversation:read"],
      serverInfo: { name: "SprintEngine Studio MCP", version: "1.2.3" },
      transportVersion: 3,
      protocolVersions: ["2025-06-18"],
    });
  };
  try {
    const result = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(requests[0].url, "http://100.64.0.9:8471/tailnet/v1/identity");
    assert.equal(requests[0].init.headers.authorization, "Bearer mctn_secret");
    assert.equal(result.ok, true);
    // A Studio that does not say how it draws itself as a machine reads as
    // no machine, never as a guessed one.
    assert.deepEqual(result.data, {
      scopes: ["conversation:read"],
      transport: { transportVersion: 3 },
      machine: null,
      environmentId: null,
    });
    global.fetch = async () =>
      jsonResponse(200, { scopes: [], transportVersion: 2, machine: { kind: "mini", color: "orange" } });
    const marked = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.deepEqual(marked.data.machine, { kind: "mini", color: "orange" });
    // Which Studio it is, as chat links name it; an id no link can carry is none.
    global.fetch = async () => jsonResponse(200, { transportVersion: 2, environmentId: "6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b" });
    const identified = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(identified.data.environmentId, "6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b");
    global.fetch = async () => jsonResponse(200, { transportVersion: 2, environmentId: "env/../1" });
    const odd = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(odd.data.environmentId, null);
    // An answer without a grant says nothing about it, not that it is empty.
    global.fetch = async () => jsonResponse(200, { transportVersion: 2 });
    const silent = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(silent.data.scopes, null);
    global.fetch = async () => jsonResponse(401, { error: { code: "unauthorized" } });
    const revoked = await readTailnetIdentity({ baseUrl: "http://100.64.0.9:8471", deviceToken: "mctn_secret" });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorCode, "unauthenticated");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a refused pairing code names the desktop and says how to get a fresh one", async () => {
  global.fetch = async () => jsonResponse(401, { error: "pairing_expired" });
  try {
    const result = await completeTailnetPairing({
      baseUrl: "http://100.64.0.9:8471",
      pairingToken: "mcpair_stale",
      deviceName: "Test phone",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /generate a fresh one from the desktop|refused the pairing/u);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a 401 about the tailnet node is not an unpairing; a plain one still is", () => {
  const { unauthorizedResult } = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
  assert.equal(unauthorizedResult({ error: { code: "peer_unverified", message: "x" } }).errorCode, "desktop_unavailable");
  const mismatch = unauthorizedResult({ error: { code: "peer_mismatch", message: "x" } });
  assert.equal(mismatch.errorCode, "unauthenticated");
  assert.match(mismatch.message, /different Tailscale device/u);
  assert.equal(unauthorizedResult({ error: { code: "unauthorized" } }).message, "This device is no longer paired with the desktop.");
  assert.equal(unauthorizedResult(null).errorCode, "unauthenticated");
});

// The desktop widens or narrows a grant after pairing; the identity read on
// foreground carries it, and the phone used to throw it away.
test("the grant the identity reports replaces the pair-time one, and only when it moved", () => {
  const session = { deviceId: "tnd_phone1", tailnetScopes: ["workspace:read", "conversation:read"] };
  assert.deepEqual(withTailnetScopes(session, ["workspace:read", "conversation:operate"]), {
    deviceId: "tnd_phone1",
    tailnetScopes: ["workspace:read", "conversation:operate"],
  });
  assert.deepEqual(withTailnetScopes(session, ["workspace:read"]).tailnetScopes, ["workspace:read"]);
  assert.equal(withTailnetScopes(session, ["conversation:read", "workspace:read"]), null);
  assert.equal(withTailnetScopes(session, null), null);
});
