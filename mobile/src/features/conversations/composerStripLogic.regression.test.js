/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// The strip under New's composer: always one line. Only the branch shrinks, and
// from the front, dropping whole leading segments before it cuts a word; then
// items leave for the "⋮" in a fixed order (branch → diff → machine). The
// chat's changes, added up for its page, are worked out here too.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  ELLIPSIS,
  MIN_BRANCH_CHARS,
  STRIP_DROP_ORDER,
  conversationChanges,
  frontTruncateBranch,
  layoutComposerStrip,
} = require(path.join(buildRoot, "src/features/conversations/composerStripLogic.js"));

test("a branch truncates from the front, a whole leading segment at a time", () => {
  assert.equal(frontTruncateBranch("fix/cli-update-output", 40), "fix/cli-update-output", "it fits: whole");
  assert.equal(frontTruncateBranch("fix/cli-update-output", 20), `${ELLIPSIS}cli-update-output`, "the reference example");
  // The segments go one at a time (the floor set aside to show the steps).
  assert.equal(frontTruncateBranch("feat/a/b-c", 9, 0), `${ELLIPSIS}a/b-c`);
  assert.equal(frontTruncateBranch("feat/a/b-c", 5, 0), `${ELLIPSIS}b-c`);
  assert.equal(frontTruncateBranch("feat/a/b-c", 3, 0), `${ELLIPSIS}-c`);
  // Above the floor, "feat/alpha/beta-gamma" drops "feat/", then "alpha/".
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 20), `${ELLIPSIS}alpha/beta-gamma`);
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 15), `${ELLIPSIS}beta-gamma`);
  assert.equal(frontTruncateBranch("feat/alpha/beta-gamma", 11), `${ELLIPSIS}beta-gamma`);
});

test("only a last segment too long alone is cut mid-word, keeping its end", () => {
  assert.equal(frontTruncateBranch("fix/cli-update-output", 12), `${ELLIPSIS}date-output`);
  assert.equal(frontTruncateBranch("a-very-long-branch-name-without-slashes", 14), `${ELLIPSIS}thout-slashes`);
  for (const width of [10, 11, 12, 13, 17]) {
    const label = frontTruncateBranch("feat/some-long-branch-name", width);
    assert.ok(label.length <= width, `${label} is no longer than ${width}`);
    assert.ok(label.startsWith(ELLIPSIS));
    assert.ok("feat/some-long-branch-name".endsWith(label.slice(1)), "the end is kept");
  }
});

test("below the floor the branch does not shrink further: it leaves the line", () => {
  assert.equal(MIN_BRANCH_CHARS, 10);
  assert.equal(frontTruncateBranch("fix/cli-update-output", MIN_BRANCH_CHARS - 1), null);
  assert.equal(frontTruncateBranch("main", 4), "main", "a short branch that fits is never refused");
});

// A strip at phone scale: an 8pt monospace advance, a 22pt machine glyph, a
// 70pt item in the diff slot and a 32pt "⋮", 4pt apart.
const CHAR = 8;
const entries = (branch = "fix/cli-update-output") => [
  { kind: "item", id: "machine", width: 22, drop: STRIP_DROP_ORDER.machine },
  { kind: "branch", id: "branch", text: branch, charWidth: CHAR, chromeWidth: 16, drop: STRIP_DROP_ORDER.branch },
  { kind: "item", id: "diff", width: 70, drop: STRIP_DROP_ORDER.diff },
];
const layout = (width, extra = {}) =>
  layoutComposerStrip({ width, gap: 4, entries: entries(), overflowWidth: 32, ...extra });
// Everything whole: 22 + (16 + 21·8) + 70 + 2 gaps of 4.
const FULL = 22 + 16 + 21 * CHAR + 70 + 2 * 4;

test("the drop order is branch, then diff, then the machine glyph, then Worktree", () => {
  assert.deepEqual(STRIP_DROP_ORDER, { branch: 1, diff: 2, machine: 3, worktree: 4 });
});

test("with room, everything is on the line, the branch whole, and no ⋮", () => {
  assert.deepEqual(layout(FULL), {
    visible: ["machine", "branch", "diff"],
    hidden: [],
    branchLabel: "fix/cli-update-output",
    overflow: false,
  });
});

test("as the line narrows the branch shrinks from the front first, nothing leaves", () => {
  const narrower = layout(FULL - 3 * CHAR);
  assert.equal(narrower.branchLabel, `${ELLIPSIS}cli-update-output`);
  assert.deepEqual(narrower.hidden, []);
  assert.equal(narrower.overflow, false);
  // One character short of "…cli-update-output", the last segment is cut, keeping its end.
  assert.equal(layout(FULL - 4 * CHAR).branchLabel, `${ELLIPSIS}li-update-output`);
  const cut = layout(FULL - 9 * CHAR);
  assert.equal(cut.branchLabel, `${ELLIPSIS}date-output`);
  assert.deepEqual(cut.hidden, []);
});

test("then the branch leaves, then the diff, then the machine", () => {
  // The branch at its floor: anything narrower moves it to the ⋮.
  const floor = FULL - (21 - MIN_BRANCH_CHARS) * CHAR;
  assert.equal(layout(floor).branchLabel?.length, MIN_BRANCH_CHARS);
  const noBranch = layout(floor - 1);
  assert.deepEqual(noBranch, { visible: ["machine", "diff"], hidden: ["branch"], branchLabel: null, overflow: true });
  // machine + diff + ⋮ + 2 gaps = 22 + 70 + 32 + 8 = 132.
  assert.deepEqual(layout(132).visible, ["machine", "diff"]);
  const noDiff = layout(131);
  assert.deepEqual(noDiff.visible, ["machine"]);
  assert.deepEqual(noDiff.hidden, ["branch", "diff"]);
  // machine + ⋮ + 1 gap = 58.
  assert.deepEqual(layout(58).visible, ["machine"]);
  const bare = layout(57);
  assert.deepEqual(bare.visible, []);
  assert.deepEqual(bare.hidden, ["machine", "branch", "diff"], "hidden in the line's own order");
  assert.equal(bare.overflow, true, "everything hidden is still reachable");
});

test("the strip never wraps: whatever the width, what is shown fits on one line", () => {
  for (let width = 70; width <= FULL + 40; width += 1) {
    const result = layout(width);
    const shown = entries().filter((entry) => result.visible.includes(entry.id));
    const used =
      shown.reduce((total, entry) => total + (entry.kind === "item" ? entry.width : entry.chromeWidth + result.branchLabel.length * CHAR), 0) +
      (result.overflow ? 32 : 0) +
      Math.max(0, shown.length + (result.overflow ? 1 : 0) - 1) * 4;
    if (result.visible.length) assert.ok(used <= width, `${width}: ${used} drawn`);
    assert.equal(result.overflow, result.hidden.length > 0, "the ⋮ only when something is hidden");
    // Items leave in order: once the diff is gone the branch is gone too, and so on.
    if (result.hidden.includes("diff")) assert.ok(result.hidden.includes("branch"));
    if (result.hidden.includes("machine")) assert.ok(result.hidden.includes("diff"));
  }
});

test("a strip with only some items still drops in order", () => {
  const result = layoutComposerStrip({
    width: 60,
    gap: 4,
    overflowWidth: 32,
    entries: [{ kind: "item", id: "diff", width: 70, drop: STRIP_DROP_ORDER.diff }],
  });
  assert.deepEqual(result, { visible: [], hidden: ["diff"], branchLabel: null, overflow: true });
  assert.deepEqual(
    layoutComposerStrip({ width: 300, gap: 4, overflowWidth: 32, entries: [] }),
    { visible: [], hidden: [], branchLabel: null, overflow: false },
    "nothing to say, and no ⋮",
  );
});

test("the chat's changes add up every turn's, and only checkpointed turns open, newest first", () => {
  assert.equal(conversationChanges([]), null);
  const turns = [
    { id: "a", at: 1, turnSeq: 1, changes: { files: 2, addedLines: 10, removedLines: 2 } },
    { id: "b", at: 2, changes: { files: 1, addedLines: 5, removedLines: 0 } },
    { id: "c", at: 3, turnSeq: 3, changes: { files: 1 } },
  ];
  const changes = conversationChanges(turns);
  assert.equal(changes.files, 4);
  assert.equal(changes.addedLines, 15);
  assert.equal(changes.removedLines, 2);
  assert.deepEqual(changes.openable.map((turn) => turn.id), ["c", "a"]);
});
