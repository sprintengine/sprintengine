/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A desktop's scheduled agents from the phone, on the desktop's Studio
// protocol: listed on `schedules.list`, driven on the method of each action's
// name under a command id, and made on `schedules.create`. A read-only
// pairing is told it may not; a desktop from before the protocol, to update.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build/mobile");
const {
  buildScheduleDraft,
  canOperateSchedules,
  createScheduledAgentsApi,
  cronForInstant,
  nextRunWords,
  readScheduledAgents,
  scheduleActionMethod,
  scheduleStatusLine,
} = require(path.join(buildRoot, "src/api/scheduledAgents.js"));
const { closeDesktopStudios } = require(path.join(buildRoot, "src/api/desktopStudio.js"));
const { fakeDesktopStudio } = require(path.join(buildRoot, "src/__verify__/fakeDesktopStudio.js"));

const listed = {
  id: "sa-1",
  prompt: "Triage new issues\nand label them",
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" },
  folderPath: "/Users/dev/app",
  cli: "claude-code",
  scheduleWords: "Weekdays at 9:00 AM",
  nextRunAt: Date.parse("2026-10-30T09:00:00.000Z"),
  lastRun: { at: 3000, ok: false, message: "The CLI is not installed." },
  lastFailureSeenAt: null,
};

let desktops = 0;
/** A paired desktop of its own for each case: the phone keeps one connection per desktop. */
const target = () => ({ baseUrl: `http://mac-mini-${++desktops}:4100`, deviceToken: "mctn_example" });

test("a listed schedule reads as the desktop's row does", () => {
  const read = readScheduledAgents({ schedules: [listed, { id: "broken" }], pausedAll: null });
  assert.equal(read.agents.length, 1, "a row without a prompt and a cron is left out");
  const [agent] = read.agents;
  assert.equal(agent.title, "Triage new issues", "untitled, its prompt's first line names it");
  assert.equal(agent.projectName, "app");
  assert.equal(agent.nextRunAt, Date.parse("2026-10-30T09:00:00.000Z"));
  assert.equal(agent.lastFailure, "The CLI is not installed.");
  assert.equal(scheduleStatusLine(agent, false), "Last run failed — The CLI is not installed.");
  assert.equal(read.pausedAll, null);
});

test("a failure the desktop has seen, a pause, and a wait read as the schedule", () => {
  const read = readScheduledAgents({
    schedules: [
      { ...listed, name: "Morning triage", pausedAt: 4000, lastFailureSeenAt: 4000 },
      { ...listed, id: "sa-2", lastFailureSeenAt: 4000, waiting: "Codex is not signed in on mac-mini" },
    ],
    pausedAll: { since: 1, until: null },
  });
  const [paused, waiting] = read.agents;
  assert.equal(paused.title, "Morning triage");
  assert.equal(paused.lastFailure, null);
  assert.equal(scheduleStatusLine(paused, false), "Paused · Weekdays at 9:00 AM");
  assert.equal(scheduleStatusLine(waiting, false), "Waiting: Codex is not signed in on mac-mini");
  assert.deepEqual(read.pausedAll, { until: null });
});

test("each action is the desktop's own schedules method", () => {
  assert.deepEqual(
    ["run", "pause", "resume", "delete"].map(scheduleActionMethod),
    ["schedules.runNow", "schedules.pause", "schedules.resume", "schedules.delete"],
  );
});

test("the phone lists, drives and makes schedules over the desktop's Studio, each change under a command id", async () => {
  const desktop = fakeDesktopStudio({
    scopes: ["workspaces:read", "workspaces:operate"],
    answer: (method) =>
      method === "schedules.list"
        ? { schedules: [listed], pausedAll: null }
        : method === "schedules.create"
          ? { schedule: { ...listed, id: "sa-9" } }
          : method === "schedules.runNow"
            ? { workspaceId: "ws-run" }
            : { schedule: listed },
  });
  const api = createScheduledAgentsApi(target(), { fetchImpl: desktop.fetchImpl, WebSocket: desktop.WebSocket });
  const listedThere = await api.list();
  assert.ok(listedThere.ok);
  assert.equal(listedThere.data.agents[0].id, "sa-1");
  assert.deepEqual(await api.act("sa-1", "run"), { ok: true, data: { id: "sa-1", action: "run" } });
  const made = await api.create({ workspaceId: "ws-1", prompt: " Check the deploy ", cron: "0 9 * * *", timezone: "UTC" });
  assert.ok(made.ok);
  assert.equal(made.data.id, "sa-9");
  const [list, run, create] = desktop.requests;
  assert.deepEqual(list, { method: "schedules.list", params: {} });
  assert.equal(run.method, "schedules.runNow");
  assert.equal(run.params.id, "sa-1");
  assert.match(run.params.commandId, /^schedule-/u);
  assert.equal(create.method, "schedules.create");
  assert.deepEqual(
    { ...create.params, commandId: undefined },
    { workspaceId: "ws-1", prompt: "Check the deploy", cron: "0 9 * * *", timezone: "UTC", commandId: undefined },
  );
  assert.equal(desktop.ticketHeaders[0].authorization, "Bearer mctn_example");
  closeDesktopStudios();
});

test("a read-only pairing is told it may not, and a desktop from before the protocol to update", async () => {
  const reader = fakeDesktopStudio({
    scopes: ["workspaces:read"],
    answer: (method) =>
      method === "schedules.list"
        ? { schedules: [], pausedAll: null }
        : { error: { code: "scope_required", message: "This pairing may not do that." } },
  });
  const options = { fetchImpl: reader.fetchImpl, WebSocket: reader.WebSocket };
  const api = createScheduledAgentsApi(target(), options);
  assert.ok((await api.list()).ok);
  const refused = await api.act("sa-1", "pause");
  assert.equal(!refused.ok && refused.errorCode, "unauthorized");

  const older = fakeDesktopStudio({ answer: () => ({}), outdated: true });
  const old = await createScheduledAgentsApi(target(), { fetchImpl: older.fetchImpl, WebSocket: older.WebSocket }).list();
  assert.equal(!old.ok && old.errorCode, "command_not_supported");
  closeDesktopStudios();
});

test("only a grant that may operate the desktop drives its schedules", () => {
  assert.equal(canOperateSchedules({ tailnetScopes: ["workspace:read"] }), false);
  assert.equal(canOperateSchedules({ tailnetScopes: ["workspace:read", "workspace:operate"] }), true);
});

test("when it runs next is a time to come", () => {
  const now = Date.parse("2026-10-29T08:00:00.000Z");
  assert.equal(nextRunWords(null, now), null);
  assert.equal(nextRunWords(now + 30_000, now), "now");
  assert.equal(nextRunWords(now + 12 * 60_000, now), "in 12m");
  assert.equal(nextRunWords(now + 5 * 3_600_000, now), "in 5h");
});

test("a one-time schedule sends its instant, and a cron naming the same minute", () => {
  const once = new Date(2026, 9, 30, 15, 5);
  const draft = buildScheduleDraft({
    workspaceId: "ws-1",
    prompt: "Ping me about the release",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    cli: "claude-code",
    once: once.getTime(),
  });
  assert.equal(draft.once, once.getTime());
  assert.equal(draft.cron, "5 15 30 10 *");
  assert.equal(cronForInstant(new Date(2026, 0, 2, 0, 0)), "0 0 2 1 *");
});

test("New chat's CLI, model, worktree and access go with a schedule only where they were picked", () => {
  const base = { workspaceId: "ws-1", prompt: "Tidy", cron: "0 9 * * *", timezone: "UTC", cli: "codex" };
  assert.deepEqual(Object.keys(buildScheduleDraft({ ...base, worktree: false, permissionPreset: null, once: null })), [
    "workspaceId",
    "prompt",
    "cron",
    "timezone",
    "cli",
  ]);
  // New chat's Desktop default: the desktop's last-picked CLI, so none is sent.
  assert.equal("cli" in buildScheduleDraft({ ...base, cli: null }), false);
  const picked = buildScheduleDraft({ ...base, model: "gpt-5", worktree: true, permissionPreset: "auto" });
  assert.equal(picked.model, "gpt-5");
  assert.equal(picked.worktree, true);
  assert.equal(picked.permissionPreset, "auto");
});
