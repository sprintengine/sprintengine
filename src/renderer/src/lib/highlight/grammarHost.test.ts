import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

import { parseTextMateGrammar } from '../../../../../packages/extension-sdk/src/content-syntaxes'
import { loadCodeLanguage, IncrementalCodeTokenizer } from './codeHighlight'
import { createGrammarHost, type GrammarHost, type GrammarSource, type GrammarWorker } from './grammarHost'
import type { GrammarRequest, GrammarResponse } from './grammarTokenizer'

// An extension's grammar runs in a worker the window can terminate, never on
// the window's thread: a pattern that backtracks without end, or includes that
// double at every level, cost the worker its life at the deadline, leave the
// code plain and stop only that extension's highlighting, while the window
// stays free. Each extension's grammars live in a registry of their own, so
// one cannot stand in for another's or for Studio's. The worker here is the
// same tokenizer the app's Web Worker runs, in a Node worker thread.

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/content-sample')
const sampleGrammar = (() => {
  const parsed = parseTextMateGrammar(
    readFileSync(join(SAMPLE, 'syntaxes/tally.tmLanguage.json'), 'utf8'),
    'source.tally',
  )
  if (!parsed.ok) throw new Error('the sample grammar does not validate')
  return parsed.grammar
})()

let workerFile = ''
const spawned: Worker[] = []

beforeAll(async () => {
  workerFile = join(mkdtempSync(join(tmpdir(), 'grammar-worker-')), 'worker.mjs')
  await build({
    stdin: {
      contents: [
        `import { parentPort } from 'node:worker_threads'`,
        `import { createGrammarTokenizer } from './grammarTokenizer'`,
        // A descheduled runner must not leave a short line plain; the host's
        // deadline is what these tests hold.
        `const tokenizer = createGrammarTokenizer({ lineTimeLimitMs: 2000 })`,
        `parentPort.on('message', async (request) => parentPort.postMessage(await tokenizer.handle(request)))`,
        `tokenizer.ready.then(() => parentPort.postMessage({ type: 'ready' }))`,
      ].join('\n'),
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: workerFile,
    logLevel: 'silent',
  })
}, 60_000)

afterAll(async () => {
  await Promise.all(spawned.map((worker) => worker.terminate()))
})

/**
 * A Node worker thread behind the Web Worker shape the host speaks to. Its
 * `ready` can be held back, as a worker started over a slow link is, and
 * every request it is sent is recorded.
 */
function spawnThread(options: { readyDelayMs?: number; sent?: GrammarRequest[] } = {}): GrammarWorker {
  const thread = new Worker(workerFile)
  spawned.push(thread)
  const handle: GrammarWorker = {
    postMessage: (message) => {
      options.sent?.push(message)
      thread.postMessage(message)
    },
    terminate: () => void thread.terminate(),
    onmessage: null,
    onerror: null,
  }
  thread.on('message', (data: GrammarResponse) => {
    if (data.type === 'ready' && options.readyDelayMs)
      setTimeout(() => handle.onmessage?.({ data }), options.readyDelayMs)
    else handle.onmessage?.({ data })
  })
  thread.on('error', (error) => handle.onerror?.(error))
  return handle
}

function source(
  extensionId: string,
  grammar: Record<string, unknown> & { scopeName: string },
  id = 'tally',
): GrammarSource {
  return { extensionId, extensionName: extensionId, language: `ext.${extensionId}.${id}`, grammar: async () => grammar }
}

/** Every role a line's tokens carry, by the text they cover. */
function roles(line: string, tokens: Array<[number, string | null]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  tokens?.forEach(([offset, role], index) => {
    if (role) out[line.slice(offset, tokens[index + 1]?.[0] ?? line.length).trim()] = role
  })
  return out
}

/** How long the window's thread was held at once while `work` ran: the longest gap between ticks. */
async function longestStall(work: () => Promise<unknown>): Promise<{ stall: number; elapsed: number }> {
  let last = Date.now()
  let stall = 0
  const ticker = setInterval(() => {
    const now = Date.now()
    stall = Math.max(stall, now - last)
    last = now
  }, 10)
  const started = Date.now()
  try {
    await work()
  } finally {
    clearInterval(ticker)
  }
  return { stall: Math.max(stall, Date.now() - last), elapsed: Date.now() - started }
}

let host: GrammarHost
beforeAll(() => {
  host = createGrammarHost({ spawn: () => spawnThread(), loadDeadlineMs: 1000 })
})

test('a grammar is compiled and run in the worker, and its tokens come back by role', async () => {
  const line = 'move 42.50 from Household:Shared to "rent" # paid'
  const tokens = await host.tokenize(source('local.sample', sampleGrammar), [line], { sliceDeadlineMs: 10_000 })
  expect(tokens).not.toBeNull()
  expect(roles(line, tokens![0])).toMatchObject({
    move: 'keyword',
    '42.50': 'number',
    'Household:Shared': 'type',
    '"rent"': 'string',
    '# paid': 'comment',
  })
})

test('a pattern that backtracks without end costs the worker at the deadline, never the window', async () => {
  const catastrophic = {
    scopeName: 'source.slow',
    patterns: [{ match: '(a+)+$', name: 'keyword.slow' }],
  }
  const failures: string[] = []
  const stop = host.onFailure((failure) => failures.push(`${failure.extensionId} ${failure.reason}`))
  let answer: unknown
  const { stall, elapsed } = await longestStall(async () => {
    // Oniguruma bounds one search's backtracking, so each line costs the
    // engine its whole per-line limit, and a block of them minutes.
    const lines = Array.from({ length: 2000 }, () => `${'a'.repeat(900)}!`)
    answer = await host.tokenize(source('local.slow', catastrophic, 'slow'), lines, { sliceDeadlineMs: 300 })
  })
  stop()
  expect(answer).toBeNull()
  expect(elapsed).toBeLessThan(4000)
  expect(stall).toBeLessThan(300)
  expect(failures).toEqual(['local.slow timeout'])
  expect(host.failed('local.slow')).toBe(true)
  // Stopped for the session: asked again, it answers plain at once, with no worker time.
  const again = Date.now()
  expect(await host.tokenize(source('local.slow', catastrophic, 'slow'), ['aaa'], { sliceDeadlineMs: 300 })).toBeNull()
  expect(Date.now() - again).toBeLessThan(100)
  // Every other extension is served by a fresh worker.
  const line = 'move 1'
  expect(
    roles(line, (await host.tokenize(source('local.sample', sampleGrammar), [line], { sliceDeadlineMs: 10_000 }))?.[0]),
  ).toMatchObject({
    move: 'keyword',
  })
}, 20_000)

test('includes that double at every level cost the worker at the deadline, never the window', async () => {
  // Validation refuses this grammar (content-syntaxes.ts); here it reaches the
  // worker anyway, as a grammar that slipped past would.
  const repository: Record<string, unknown> = { r0: { match: 'a', name: 'keyword.x' } }
  for (let level = 1; level <= 26; level += 1)
    repository[`r${level}`] = { patterns: [{ include: `#r${level - 1}` }, { include: `#r${level - 1}` }] }
  const doubling = { scopeName: 'source.doubling', patterns: [{ include: '#r26' }], repository }
  let answer: unknown
  const { stall, elapsed } = await longestStall(async () => {
    answer = await host.tokenize(source('local.doubling', doubling, 'doubling'), ['b'.repeat(20)], {
      sliceDeadlineMs: 300,
    })
  })
  expect(answer).toBeNull()
  expect(elapsed).toBeLessThan(4000)
  expect(stall).toBeLessThan(300)
  expect(host.failed('local.doubling')).toBe(true)
}, 20_000)

test('a grammar’s scope never stands in for another extension’s, or for one of Studio’s', async () => {
  // Two extensions declare the same scope, with different rules; a third
  // declares TypeScript's own.
  const words = (word: string, scopeName: string) => ({
    scopeName,
    patterns: [{ match: `\\b${word}\\b`, name: 'keyword.x' }],
  })
  const first = await host.tokenize(source('local.first', words('alpha', 'source.same')), ['alpha beta'], {
    sliceDeadlineMs: 10_000,
  })
  const second = await host.tokenize(source('local.second', words('beta', 'source.same')), ['alpha beta'], {
    sliceDeadlineMs: 10_000,
  })
  expect(roles('alpha beta', first![0])).toEqual({ alpha: 'keyword' })
  expect(roles('alpha beta', second![0])).toEqual({ beta: 'keyword' })

  const typed = await host.tokenize(source('local.typed', words('const', 'source.ts'), 'typed'), ['const x'], {
    sliceDeadlineMs: 10_000,
  })
  expect(roles('const x', typed![0])).toEqual({ const: 'keyword' })
  // Studio's TypeScript is its own grammar on the window's thread, untouched.
  const engine = await loadCodeLanguage('typescript')
  // The engine's per-line limit reads the clock; a descheduled runner must
  // not leave the line plain (as codeHighlight.test.ts holds it too).
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
  const [line] = new IncrementalCodeTokenizer(engine, 'typescript').update('interface Shape {}', true)
  clock.mockRestore()
  expect(line!.tokens.find((token) => token.content === 'interface')?.color).toBe('var(--sem-syntax-keyword)')
})

test('a worker slow to start blames no extension: the code stays plain, and it is tried again later', async () => {
  // A worker that never says it is ready, as one fetched over a dead link.
  let spawns = 0
  const silent = createGrammarHost({
    spawn: () => {
      spawns += 1
      return spawns === 1 ? { postMessage() {}, terminate() {}, onmessage: null, onerror: null } : spawnThread()
    },
    startupTimeoutMs: 200,
    startupRetryMs: 300,
  })
  const failures: string[] = []
  silent.onFailure((failure) => failures.push(failure.extensionId))
  expect(await silent.tokenize(source('local.sample', sampleGrammar), ['move 1'], { sliceDeadlineMs: 100 })).toBeNull()
  expect(silent.failed('local.sample')).toBe(false)
  // Within the wait, it does not start another.
  expect(await silent.tokenize(source('local.sample', sampleGrammar), ['move 1'], { sliceDeadlineMs: 100 })).toBeNull()
  expect(spawns).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 350))
  // Tried again: the next worker answers. It too has 200ms to say it is
  // ready, which a loaded machine can miss; that is one more wait, not a
  // failure, so the test asks until the code is coloured.
  const tokens = await vi.waitFor(
    async () => {
      const tried = await silent.tokenize(source('local.sample', sampleGrammar), ['move 1'], {
        sliceDeadlineMs: 10_000,
      })
      if (!tried) throw new Error('the worker has not started yet')
      return tried
    },
    { timeout: 15_000, interval: 100 },
  )
  expect(roles('move 1', tokens[0])).toMatchObject({ move: 'keyword' })
  expect(failures).toEqual([])
}, 20_000)

test('a slow start counts against no budget: the first request’s slices are timed from when they are sent', async () => {
  const slowStart = createGrammarHost({ spawn: () => spawnThread({ readyDelayMs: 600 }), loadDeadlineMs: 1000 })
  const line = 'move 1'
  const tokens = await slowStart.tokenize(source('local.sample', sampleGrammar), [line], { sliceDeadlineMs: 300 })
  expect(roles(line, tokens?.[0])).toMatchObject({ move: 'keyword' })
  expect(slowStart.failed('local.sample')).toBe(false)
}, 20_000)

test('a large document goes in slices, each with its own budget, the grammar’s state carried across', async () => {
  const sent: GrammarRequest[] = []
  const sliced = createGrammarHost({ spawn: () => spawnThread({ sent }), loadDeadlineMs: 1000, sliceLines: 400 })
  const lines: string[] = Array.from({ length: 2000 }, (_, index) => (index === 399 ? 'to "open' : 'move 1'))
  lines[400] = 'still" move'
  const tokens = await sliced.tokenize(source('local.sample', sampleGrammar), lines, {
    sliceDeadlineMs: 10_000,
    key: 'ledger.tally',
  })
  expect(tokens).toHaveLength(2000)
  expect(sent.filter((request) => request.type === 'load')).toHaveLength(1)
  expect(
    sent
      .filter((request) => request.type === 'tokenize')
      .map((request) => request.type === 'tokenize' && request.lines.length),
  ).toEqual([400, 400, 400, 400, 400])
  // A string opened on the last line of one slice runs on into the next.
  expect(roles('still" move', tokens![400])).toMatchObject({ 'still"': 'string', move: 'keyword' })
}, 30_000)

test('a pass the editor cancelled, or one a newer pass replaced, stops and never queues in front of others', async () => {
  // A worker that answers each slice a little later, recording what it was asked.
  const sent: GrammarRequest[] = []
  const slow: GrammarWorker = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(request) {
      sent.push(request)
      const answer: GrammarResponse =
        request.type === 'load'
          ? { type: 'loaded', id: request.id }
          : { type: 'tokens', id: request.id, lines: request.lines.map(() => [[0, null]]) }
      setTimeout(() => slow.onmessage?.({ data: answer }), 30)
    },
  }
  const queued = createGrammarHost({
    spawn: () => {
      setTimeout(() => slow.onmessage?.({ data: { type: 'ready' } }), 0)
      return slow
    },
    sliceLines: 10,
  })
  const doc = (n: number) => Array.from({ length: 30 }, () => `line ${n}`)
  const src = source('local.sample', sampleGrammar)
  const first = queued.tokenize(src, doc(1), { sliceDeadlineMs: 1000, key: 'a' })
  // Queued behind it: an older pass for b, replaced by a newer one before it starts.
  const olderB = queued.tokenize(src, doc(2), { sliceDeadlineMs: 1000, key: 'b' })
  const newerB = queued.tokenize(src, doc(3), { sliceDeadlineMs: 1000, key: 'b' })
  expect(await olderB).toBeNull()
  // A newer pass for a stops the running one at its next slice.
  const newerA = queued.tokenize(src, doc(4), { sliceDeadlineMs: 1000, key: 'a' })
  expect(await first).toBeNull()
  expect(await newerB).toHaveLength(30)
  expect(await newerA).toHaveLength(30)
  // A pass cancelled before it runs posts nothing.
  const before = sent.length
  expect(await queued.tokenize(src, doc(5), { sliceDeadlineMs: 1000, key: 'c', cancelled: () => true })).toBeNull()
  expect(sent.length).toBe(before)
  // Nothing of the older passes ran past their first slice.
  const tokenized = sent.flatMap((request) => (request.type === 'tokenize' ? [request.lines[0]] : []))
  expect(tokenized.filter((line) => line === 'line 2')).toEqual([])
  expect(tokenized.filter((line) => line === 'line 1').length).toBeLessThanOrEqual(1)
})
