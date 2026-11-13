/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The machines a paired desktop relays the phone to: listed by the desktop
// (`environment.relayed`), each filed as a session of its own, never stored,
// and asked on its own connection, with a ticket the desktop's listener mints
// for that machine and the machine's own Studio path.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const { relayedSessions } = require(path.join(buildRoot, "src/api/relayedMachines.js"));
const { closeDesktopStudios, desktopStudio, studioTargetOf } = require(
  path.join(buildRoot, "src/api/desktopStudio.js"),
);
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

const BOX = "7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
let desktops = 0;
const pairing = (status = "online") => ({
  deviceId: `dev-${++desktops}`,
  desktopName: "mac-mini",
  baseUrl: `http://mac-mini-${desktops}:4100`,
  deviceToken: "mctn_example",
  pairedAt: "2026-11-13T10:00:00.000Z",
  tailnetScopes: ["conversation:read"],
  environmentId: "env-mac-mini",
  machineMark: { kind: "laptop", color: "blue" },
  status,
});

function desktop() {
  return fakeDesktopStudio({
    answer: (method) =>
      method === "environment.relayed"
        ? {
            environments: [
              {
                environmentId: BOX,
                name: "build-box",
                kind: "ssh",
                connected: true,
                mark: { kind: "server", color: "green" },
              },
              { environmentId: "env-away", name: "lab", kind: "ssh", connected: false },
            ],
          }
        : method === "conversation.list"
          ? { conversations: [] }
          : { error: { code: "unknown_method", message: "No method." } },
  });
}

test("each machine a desktop relays is a session of its own, reached at its own path with its own ticket", async () => {
  const fake = desktop();
  const options = { fetchImpl: fake.fetchImpl, WebSocket: fake.WebSocket };
  const paired = pairing();
  const relayed = await relayedSessions(paired, options);
  assert.deepEqual(
    relayed.map((session) => [
      session.deviceId,
      session.desktopName,
      session.relayedEnvironmentId,
      session.relayedVia,
      session.status,
    ]),
    [
      [`${paired.deviceId}~${BOX}`, "build-box", BOX, paired.deviceId, "online"],
      [`${paired.deviceId}~env-away`, "lab", "env-away", paired.deviceId, "offline"],
    ],
  );
  // Its mark is the machine's, never the desktop's.
  assert.deepEqual(relayed[0].machineMark, { kind: "server", color: "green" });
  assert.equal(relayed[1].machineMark, undefined);
  // The same pairing's token, the desktop's address, and the machine named.
  assert.deepEqual(studioTargetOf(relayed[0]), {
    baseUrl: paired.baseUrl,
    deviceToken: paired.deviceToken,
    relayedEnvironmentId: BOX,
  });

  await (await desktopStudio(studioTargetOf(relayed[0]), options)).request("conversation.list", {});
  assert.deepEqual(fake.ticketBodies, [{}, { environmentId: BOX }]);
  assert.ok(fake.socketUrls[0].includes("/tailnet/v1/studio?ticket="), fake.socketUrls[0]);
  assert.ok(fake.socketUrls[1].includes(`/tailnet/v1/environments/${BOX}/studio?ticket=`), fake.socketUrls[1]);
  closeDesktopStudios();
});

test("a revoked pairing, or a relayed session itself, relays nothing", async () => {
  const fake = desktop();
  const options = { fetchImpl: fake.fetchImpl, WebSocket: fake.WebSocket };
  assert.deepEqual(await relayedSessions(pairing("revoked"), options), []);
  const [machine] = await relayedSessions(pairing(), options);
  assert.deepEqual(await relayedSessions(machine, options), []);
  closeDesktopStudios();
});
