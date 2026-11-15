// Runs the phone's regression suites on `node --test`: every
// `*.regression.test.js` under `src/`, found on disk rather than listed, so a
// suite that is added runs without anyone remembering to name it. The modules
// they load are compiled first by `tsconfig.test.json` into
// `.mobile-test-build/`; a suite whose module is not compiled fails when it
// requires it.
//
// It also fails, before running anything, on a test this run would pass over
// (a `*.test.ts`, or a `*.test.js` not named `*.regression.test.js`), and on
// finding no suites at all, so a moved folder cannot leave `node --test`
// passing on nothing.
"use strict";

const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");

const mobile = dirname(require.resolve("../package.json"));
const SUITE = /\.regression\.test\.js$/u;
const TEST = /\.test\.[cm]?[jt]sx?$/u;

/** Every file under `folder`, as a path from the phone's folder, in a stable order. */
function filesUnder(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...filesUnder(path));
    } else if (entry.isFile()) found.push(relative(mobile, path));
  }
  return found;
}

const files = filesUnder(join(mobile, "src")).sort();
const suites = files.filter((file) => SUITE.test(file));
const passedOver = files.filter((file) => TEST.test(file) && !SUITE.test(file));
if (passedOver.length > 0) {
  console.error(
    `Tests this run would pass over (name a suite *.regression.test.js): ${passedOver.join(", ")}`,
  );
  process.exit(1);
}
if (suites.length === 0) {
  console.error("No *.regression.test.js suites were found under src/.");
  process.exit(1);
}
console.log(`Running ${suites.length} suites.`);
const run = spawnSync(process.execPath, ["--test", ...suites], { cwd: mobile, stdio: "inherit" });
process.exit(run.status ?? 1);
