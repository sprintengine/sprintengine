// The part of vitest `scripts/vitest-bridge.cjs` gives the shared runtime's
// tests on `node:test`. The phone's runtime test build resolves `vitest` here
// (tsconfig.runtime-test.json), so a test that reaches for anything else fails
// that build rather than passing on the desktop and breaking here.

type TestBody = () => void | Promise<void>

export declare function test(name: string, body: TestBody): void
export declare function it(name: string, body: TestBody): void
export declare function describe(name: string, body: () => void): void
export declare function beforeEach(body: TestBody): void
export declare function afterEach(body: TestBody): void

type Matchers = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toStrictEqual(expected: unknown): void
  toMatchObject(expected: object): void
  toHaveLength(length: number): void
  toBeNull(): void
  toBeUndefined(): void
  toContain(item: unknown): void
  toMatch(pattern: string | RegExp): void
  toBeInstanceOf(type: abstract new (...args: never[]) => unknown): void
  toBeGreaterThan(bound: number): void
  toBeLessThanOrEqual(bound: number): void
  toHaveBeenCalledTimes(times: number): void
  toThrow(expected?: string | RegExp | (abstract new (...args: never[]) => unknown)): void
}

type Settled = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> }

export declare const expect: {
  (actual: unknown, message?: string): Matchers & { not: Matchers; resolves: Settled; rejects: Settled }
  any(type: abstract new (...args: never[]) => unknown): never
  stringMatching(pattern: string | RegExp): never
}

type Spy = {
  mock: { readonly calls: unknown[][] }
  mockImplementation(implementation: (...args: never[]) => unknown): Spy
  mockRestore(): void
}

export declare const vi: {
  spyOn<T extends object, K extends keyof T>(object: T, method: K): Spy
}
