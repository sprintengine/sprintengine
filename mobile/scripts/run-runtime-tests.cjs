// Runs the shared client runtime's tests that `tsconfig.runtime-test.json`
// compiled into `.mobile-test-build/`, on `node --test` with the vitest bridge.
// The files come from that tsconfig, so a test added there runs here, and a
// compiled file that is missing (a moved `rootDir` or `outDir`) fails the run
// instead of leaving `node --test` to pass on no tests at all.
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");
const ts = require("typescript");

const mobile = dirname(require.resolve("../package.json"));
const configPath = join(mobile, "tsconfig.runtime-test.json");
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, mobile, undefined, configPath);
const outDir = config.options.outDir;
const rootDir = config.options.rootDir;
const sources = config.fileNames.filter((file) => file.endsWith(".test.ts"));
if (sources.length === 0) {
  console.error("tsconfig.runtime-test.json lists no tests.");
  process.exit(1);
}
const compiled = sources.map((file) => join(outDir, relative(rootDir, file)).replace(/\.ts$/u, ".js"));
const missing = compiled.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Not compiled: ${missing.map((file) => relative(mobile, file)).join(", ")}`);
  process.exit(1);
}
const run = spawnSync(
  process.execPath,
  ["--require", require.resolve("./vitest-bridge.cjs"), "--test", ...compiled],
  { cwd: mobile, stdio: "inherit" },
);
process.exit(run.status ?? 1);
