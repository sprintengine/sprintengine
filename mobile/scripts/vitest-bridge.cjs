// The shared client runtime's tests are written for vitest, which the desktop
// suite runs. The phone's suite runs on `node --test` and has no vitest, so this
// bridge gives those same files the part of vitest they use, on `node:test`:
// `test`, `describe`, `beforeEach`, `afterEach`, `expect` with the matchers
// below, and `vi.spyOn`. Loaded with `node --require`; `require('vitest')` from
// a compiled test then answers this module. A matcher missing here fails the
// phone's test build (vitest-bridge.d.ts declares only these), never silently.
"use strict";

const Module = require("node:module");
const assert = require("node:assert/strict");
const { inspect, isDeepStrictEqual } = require("node:util");
const nodeTest = require("node:test");

class Asymmetric {
  constructor(describe, matches) {
    this.describe = describe;
    this.matches = matches;
  }
  [inspect.custom]() {
    return this.describe;
  }
}

const isPlainRecord = (value) => typeof value === "object" && value !== null;

// vitest's `toEqual`: recursive, properties holding `undefined` count as absent,
// prototypes are not compared, asymmetric matchers match.
function equals(actual, expected, subset) {
  if (expected instanceof Asymmetric) return expected.matches(actual);
  if (Object.is(actual, expected)) return true;
  if (!isPlainRecord(actual) || !isPlainRecord(expected)) return false;
  // An error's name and message are not own enumerable keys; vitest compares them.
  if (expected instanceof Error || actual instanceof Error) {
    if (!(expected instanceof Error) || !(actual instanceof Error)) return false;
    if (actual.name !== expected.name || actual.message !== expected.message) return false;
  }
  if (expected instanceof Date || actual instanceof Date)
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  if (expected instanceof RegExp || actual instanceof RegExp)
    return String(actual) === String(expected);
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => equals(actual[index], item, subset));
  }
  if (expected instanceof Map || actual instanceof Map) {
    if (!(expected instanceof Map) || !(actual instanceof Map) || actual.size !== expected.size) return false;
    for (const [key, value] of expected) if (!actual.has(key) || !equals(actual.get(key), value, subset)) return false;
    return true;
  }
  if (expected instanceof Set || actual instanceof Set) {
    if (!(expected instanceof Set) || !(actual instanceof Set) || actual.size !== expected.size) return false;
    for (const value of expected) if (![...actual].some((candidate) => equals(candidate, value, subset))) return false;
    return true;
  }
  const keys = (value) => Object.keys(value).filter((key) => value[key] !== undefined);
  const expectedKeys = keys(expected);
  if (!subset) {
    const actualKeys = keys(actual);
    if (actualKeys.length !== expectedKeys.length) return false;
  }
  return expectedKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(actual, key) && equals(actual[key], expected[key], subset),
  );
}

const show = (value) => inspect(value, { depth: 8, breakLength: 100 });

function matchers(actual, negated, label) {
  const check = (pass, message) => {
    if (pass === negated)
      assert.fail(`${label ? `${label}: ` : ""}${negated ? "Expected not: " : "Expected "}${message}`);
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected) => check(equals(actual, expected, false), `${show(actual)} to equal ${show(expected)}`),
    toStrictEqual: (expected) =>
      check(isDeepStrictEqual(actual, expected), `${show(actual)} to strictly equal ${show(expected)}`),
    toMatchObject: (expected) =>
      check(equals(actual, expected, true), `${show(actual)} to match ${show(expected)}`),
    toHaveLength: (length) =>
      check(actual != null && actual.length === length, `${show(actual)} to have length ${length}`),
    toBeNull: () => check(actual === null, `${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `${show(actual)} to be undefined`),
    toContain: (item) =>
      check(
        actual != null && typeof actual.includes === "function" && actual.includes(item),
        `${show(actual)} to contain ${show(item)}`,
      ),
    toMatch: (pattern) =>
      check(
        typeof actual === "string" && (typeof pattern === "string" ? actual.includes(pattern) : pattern.test(actual)),
        `${show(actual)} to match ${show(pattern)}`,
      ),
    toBeInstanceOf: (type) => check(actual instanceof type, `${show(actual)} to be an instance of ${type.name}`),
    toBeGreaterThan: (bound) => check(actual > bound, `${show(actual)} to be greater than ${bound}`),
    toBeLessThanOrEqual: (bound) => check(actual <= bound, `${show(actual)} to be at most ${bound}`),
    toHaveBeenCalledTimes: (times) =>
      check(actual.mock.calls.length === times, `a spy called ${actual.mock.calls.length} times to be called ${times}`),
    toThrow: (expected) => {
      if (typeof actual !== "function") assert.fail(`Expected a function to call, got ${show(actual)}`);
      let thrown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      check(threw && thrownMatches(thrown, expected), `a function to throw ${show(expected)}`);
    },
  };
}

function thrownMatches(error, expected) {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "function") return error instanceof expected;
  return equals(error, expected, true);
}

function settled(promise, negated, outcome, label) {
  const run = (name) => async (expected) => {
    let value;
    let rejected = false;
    try {
      value = await promise;
    } catch (error) {
      rejected = true;
      value = error;
    }
    if (outcome === "rejects") {
      if (!rejected) assert.fail(`Expected a rejection, got ${show(value)}`);
      if (name === "toThrow") {
        if (thrownMatches(value, expected) === negated) assert.fail(`Expected a rejection with ${show(expected)}, got ${show(value)}`);
        return;
      }
    } else if (rejected) assert.fail(`Expected a value, got the rejection ${show(value)}`);
    matchers(value, negated, label)[name](expected);
  };
  return new Proxy({}, { get: (_target, name) => (typeof name === "string" ? run(name) : undefined) });
}

function expect(actual, label) {
  return Object.assign(matchers(actual, false, label), {
    not: matchers(actual, true, label),
    resolves: settled(actual, false, "resolves", label),
    rejects: settled(actual, false, "rejects", label),
  });
}
expect.any = (type) =>
  new Asymmetric(`Any<${type.name}>`, (value) =>
    type === String ? typeof value === "string" || value instanceof String
    : type === Number ? typeof value === "number" || value instanceof Number
    : type === Boolean ? typeof value === "boolean" || value instanceof Boolean
    : type === Function ? typeof value === "function"
    : type === Object ? typeof value === "object" && value !== null
    : value instanceof type,
  );
expect.stringMatching = (pattern) =>
  new Asymmetric(`StringMatching ${pattern}`, (value) =>
    typeof value === "string" && (typeof pattern === "string" ? value.includes(pattern) : pattern.test(value)),
  );

const vi = {
  spyOn(object, method) {
    const original = object[method];
    const spy = nodeTest.mock.method(object, method);
    return {
      mock: {
        get calls() {
          return spy.mock.calls.map((call) => call.arguments);
        },
      },
      mockImplementation(implementation) {
        spy.mock.mockImplementation(implementation);
        return this;
      },
      mockRestore() {
        spy.mock.restore();
        object[method] = original;
      },
    };
  },
};

// vitest stops a test after five seconds; node:test never does. A hung test
// fails here too, with room for a slow machine.
const TEST_TIMEOUT_MS = 60_000;
const timed = (run) => (name, body) => run(name, { timeout: TEST_TIMEOUT_MS }, body);

const bridge = {
  test: timed(nodeTest.test),
  it: timed(nodeTest.it),
  describe: nodeTest.describe,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  expect,
  vi,
};

const load = Module._load;
Module._load = function loadWithVitest(request, parent, isMain) {
  if (request === "vitest") return bridge;
  return load.call(this, request, parent, isMain);
};
