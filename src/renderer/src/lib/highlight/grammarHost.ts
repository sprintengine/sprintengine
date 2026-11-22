import type { GrammarRequest, GrammarResponse, TokenLines } from './grammarTokenizer'

export type { TokenLines } from './grammarTokenizer'

// The window's side of the grammar worker: an extension's grammar is
// compiled and run in a worker (grammarTokenizer.ts), never on the window's
// thread, and every step of the work has a budget held here. A TextMate
// engine checks its own time limit only between two regular-expression
// searches, and one search can backtrack for minutes, so a grammar step that
// outlives its budget terminates the worker, the code stays plain, and that
// extension's highlighting stops for the rest of the window's session (the
// person is told which extension, once). A fresh worker serves everyone else.
//
// Only a grammar's own work is held against it:
// - the worker starting (fetching its script, compiling the engine's
//   WebAssembly, which over a slow link to a remote Studio can take seconds)
//   has a generous budget of its own, and running out of it blames nobody:
//   the code stays plain and the worker is tried again a little later;
// - loading a grammar is a step of its own, with its own budget;
// - lines are tokenized in slices, each with its own budget, the grammar's
//   state carried from one slice to the next, so a large document is never
//   one long step that size alone could make too slow.
//
// Requests run one at a time, each budget counted from when its step is
// sent. A request is dropped before its next slice once its caller no longer
// wants it (the editor cancelled the pass) or once a newer one for the same
// document arrived, and a newer one replaces an older one still waiting, so
// stale passes never queue up in front of other documents and chat blocks.

export type GrammarWorker = {
  postMessage(message: GrammarRequest): void
  terminate(): void
  onmessage: ((event: { data: GrammarResponse }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** A contributed language, and how to fetch its grammar from the window's Studio. */
export type GrammarSource = {
  extensionId: string
  extensionName: string
  /** Its name in the highlighter: `ext.<install key>.<id>`. */
  language: string
  grammar(): Promise<Record<string, unknown> & { scopeName: string }>
}

export type GrammarFailure = {
  extensionId: string
  extensionName: string
  reason: 'timeout' | 'error'
  message: string
}

export type TokenizeOptions = {
  /** Each slice's budget. */
  sliceDeadlineMs: number
  /** The document's key: a newer request under it replaces an older one. */
  key?: string
  /** Whether the caller still wants the answer; checked before each slice. */
  cancelled?: () => boolean
}

export type GrammarHost = {
  /** The lines' tokens, or null when they stay plain (the grammar failed, the worker is not up, the request was dropped). */
  tokenize(source: GrammarSource, lines: readonly string[], options: TokenizeOptions): Promise<TokenLines | null>
  /** Whether an extension's highlighting stopped this session. */
  failed(extensionId: string): boolean
  onFailure(listener: (failure: GrammarFailure) => void): () => void
}

export type GrammarHostOptions = {
  spawn: () => GrammarWorker
  /** How long the worker may take to start; past it, nobody is blamed and it is tried again later. */
  startupTimeoutMs?: number
  /** How long to leave code plain after a start that did not finish, before trying again. */
  startupRetryMs?: number
  /** A grammar's load and first compile. */
  loadDeadlineMs?: number
  /** Lines per slice. */
  sliceLines?: number
}

type Job = {
  source: GrammarSource
  lines: readonly string[]
  options: TokenizeOptions
  resolve: (tokens: TokenLines | null) => void
  superseded: boolean
}

export function createGrammarHost(options: GrammarHostOptions): GrammarHost {
  const startupTimeoutMs = options.startupTimeoutMs ?? 20_000
  const startupRetryMs = options.startupRetryMs ?? 15_000
  const loadDeadlineMs = options.loadDeadlineMs ?? 3000
  const sliceLines = options.sliceLines ?? 400

  let worker: { handle: GrammarWorker; ready: Promise<boolean> } | null = null
  let loaded = new Set<string>()
  let startupRetryAt = 0
  let nextId = 1
  let nextBlock = 1
  const failedExtensions = new Set<string>()
  const listeners = new Set<(failure: GrammarFailure) => void>()
  const queue: Job[] = []
  let running: Job | null = null

  const stopWorker = () => {
    if (!worker) return
    worker.handle.onmessage = null
    worker.handle.onerror = null
    worker.handle.terminate()
    worker = null
    loaded = new Set()
  }

  /** The worker, once it says it can serve; false when it did not start in time (nobody's fault). */
  const readyWorker = async (): Promise<GrammarWorker | null> => {
    if (!worker) {
      if (Date.now() < startupRetryAt) return null
      const handle = options.spawn()
      const ready = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), startupTimeoutMs)
        handle.onmessage = (event) => {
          if (event.data.type !== 'ready') return
          clearTimeout(timer)
          resolve(true)
        }
        handle.onerror = () => {
          clearTimeout(timer)
          resolve(false)
        }
      })
      worker = { handle, ready }
    }
    const current = worker
    if (await current.ready) return current.handle
    if (worker === current) stopWorker()
    startupRetryAt = Date.now() + startupRetryMs
    return null
  }

  /** One step: its request sent, its answer, or why there is none, within `deadlineMs`. */
  const step = (handle: GrammarWorker, request: GrammarRequest, deadlineMs: number) =>
    new Promise<GrammarResponse | 'timeout' | 'crashed'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), deadlineMs)
      handle.onmessage = (event) => {
        if (!('id' in event.data) || event.data.id !== request.id) return
        clearTimeout(timer)
        resolve(event.data)
      }
      handle.onerror = () => {
        clearTimeout(timer)
        resolve('crashed')
      }
      handle.postMessage(request)
    })

  const fail = (source: GrammarSource, reason: GrammarFailure['reason'], message: string) => {
    if (failedExtensions.has(source.extensionId)) return
    failedExtensions.add(source.extensionId)
    for (const listener of [...listeners])
      listener({ extensionId: source.extensionId, extensionName: source.extensionName, reason, message })
  }

  /** A step that ran out of budget, crashed or failed: the worker goes, and the grammar is blamed. */
  const blame = (source: GrammarSource, answer: 'timeout' | 'crashed' | { message: string }, budgetMs: number) => {
    if (answer === 'timeout' || answer === 'crashed') stopWorker()
    fail(
      source,
      answer === 'timeout' ? 'timeout' : 'error',
      answer === 'timeout'
        ? `Its grammar took longer than ${budgetMs} ms, so its highlighting is off until the window reloads.`
        : answer === 'crashed'
          ? 'Its grammar stopped the highlighter, so its highlighting is off until the window reloads.'
          : `Its grammar could not be used: ${answer.message}`,
    )
  }

  const wanted = (job: Job) => !job.superseded && !job.options.cancelled?.()

  const run = async (job: Job): Promise<TokenLines | null> => {
    const { source } = job
    if (failedExtensions.has(source.extensionId) || !wanted(job)) return null
    let handle = await readyWorker()
    if (!handle) return null
    if (!loaded.has(source.language)) {
      let grammar: Awaited<ReturnType<GrammarSource['grammar']>>
      try {
        grammar = await source.grammar()
      } catch {
        // Not served now (the Studio is away, the extension is off): plain, and asked again next time.
        return null
      }
      handle = await readyWorker()
      if (!handle) return null
      const answer = await step(
        handle,
        { type: 'load', id: nextId++, extensionId: source.extensionId, language: source.language, grammar },
        loadDeadlineMs,
      )
      if (answer === 'timeout' || answer === 'crashed' || answer.type === 'failed') {
        blame(
          source,
          answer === 'timeout' || answer === 'crashed' ? answer : (answer as { message: string }),
          loadDeadlineMs,
        )
        return null
      }
      loaded.add(source.language)
    }
    const stateKey = job.options.key ?? `block-${nextBlock++}`
    const out: TokenLines = []
    for (let start = 0; start < job.lines.length || start === 0; start += sliceLines) {
      if (!wanted(job)) return null
      handle = await readyWorker()
      if (!handle || !loaded.has(source.language)) return null
      const answer = await step(
        handle,
        {
          type: 'tokenize',
          id: nextId++,
          extensionId: source.extensionId,
          language: source.language,
          lines: job.lines.slice(start, start + sliceLines),
          stateKey,
          resume: start > 0,
        },
        job.options.sliceDeadlineMs,
      )
      if (answer === 'timeout' || answer === 'crashed' || answer.type !== 'tokens') {
        blame(
          source,
          answer === 'timeout' || answer === 'crashed'
            ? answer
            : { message: answer.type === 'failed' ? answer.message : 'no tokens' },
          job.options.sliceDeadlineMs,
        )
        return null
      }
      out.push(...answer.lines)
      if (job.lines.length === 0) break
    }
    return out
  }

  const pump = () => {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = job
    void run(job)
      .catch(() => null)
      .then((tokens) => {
        running = null
        job.resolve(tokens)
        pump()
      })
  }

  return {
    tokenize(source, lines, tokenizeOptions) {
      return new Promise((resolve) => {
        const key = tokenizeOptions.key
        if (key !== undefined) {
          // A newer pass for the same document replaces one still waiting, and
          // stops the one running at its next slice.
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            if (queue[index]!.options.key !== key) continue
            queue[index]!.resolve(null)
            queue.splice(index, 1)
          }
          if (running?.options.key === key) running.superseded = true
        }
        queue.push({ source, lines, options: tokenizeOptions, resolve, superseded: false })
        pump()
      })
    },
    failed: (extensionId) => failedExtensions.has(extensionId),
    onFailure(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
