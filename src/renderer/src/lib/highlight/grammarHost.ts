import type { CodeRole } from './codeTheme'
import type { GrammarRequest, GrammarResponse } from './grammarTokenizer'

// The window's side of the grammar worker: an extension's grammar is
// compiled and run in a worker (grammarTokenizer.ts), never on the window's
// thread, and every request has a deadline. A TextMate engine checks its own
// time limit only between two regular-expression searches, and one search can
// backtrack for minutes, so the deadline is held here: a request that
// outlives it terminates the worker, the code stays plain, and that
// extension's highlighting stops for the rest of the window's session (the
// person is told which extension, once). A fresh worker serves everyone else.
//
// Requests run one at a time, each deadline counted from when its request is
// sent, so a slow one never spends the next one's time.

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

/** Each line's tokens as `[offset, role]`. */
export type TokenLines = Array<Array<[number, CodeRole | null]>>

export type GrammarFailure = {
  extensionId: string
  extensionName: string
  reason: 'timeout' | 'error'
  message: string
}

export type GrammarHost = {
  /** The lines' tokens, or null when they stay plain (the grammar failed, now or earlier). */
  tokenize(source: GrammarSource, lines: readonly string[], deadlineMs: number): Promise<TokenLines | null>
  /** Whether an extension's highlighting stopped this session. */
  failed(extensionId: string): boolean
  onFailure(listener: (failure: GrammarFailure) => void): () => void
}

export function createGrammarHost(options: { spawn: () => GrammarWorker }): GrammarHost {
  let worker: GrammarWorker | null = null
  let loaded = new Set<string>()
  let nextId = 1
  let queue: Promise<unknown> = Promise.resolve()
  const failedExtensions = new Set<string>()
  const listeners = new Set<(failure: GrammarFailure) => void>()

  const stopWorker = () => {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
    loaded = new Set()
  }
  const fail = (source: GrammarSource, reason: GrammarFailure['reason'], message: string) => {
    if (failedExtensions.has(source.extensionId)) return
    failedExtensions.add(source.extensionId)
    for (const listener of [...listeners])
      listener({ extensionId: source.extensionId, extensionName: source.extensionName, reason, message })
  }

  const run = async (
    source: GrammarSource,
    lines: readonly string[],
    deadlineMs: number,
  ): Promise<TokenLines | null> => {
    if (failedExtensions.has(source.extensionId)) return null
    let grammar: Awaited<ReturnType<GrammarSource['grammar']>> | undefined
    if (!loaded.has(source.language) || !worker) {
      try {
        grammar = await source.grammar()
      } catch {
        // Not served now (the Studio is away, the extension is off): plain, and asked again next time.
        return null
      }
    }
    worker ??= options.spawn()
    const current = worker
    const id = nextId++
    const answer = await new Promise<GrammarResponse | 'timeout' | 'crashed'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), deadlineMs)
      current.onmessage = (event) => {
        if (event.data.id !== id) return
        clearTimeout(timer)
        resolve(event.data)
      }
      current.onerror = () => {
        clearTimeout(timer)
        resolve('crashed')
      }
      current.postMessage({
        id,
        extensionId: source.extensionId,
        language: source.language,
        ...(loaded.has(source.language) ? {} : { grammar }),
        lines,
      })
    })
    if (answer === 'timeout' || answer === 'crashed') {
      stopWorker()
      fail(
        source,
        answer === 'timeout' ? 'timeout' : 'error',
        answer === 'timeout'
          ? `Its grammar took longer than ${deadlineMs} ms, so its highlighting is off until the window reloads.`
          : 'Its grammar stopped the highlighter, so its highlighting is off until the window reloads.',
      )
      return null
    }
    current.onmessage = null
    current.onerror = null
    if (!answer.ok) {
      fail(source, 'error', `Its grammar could not be used: ${answer.message}`)
      return null
    }
    loaded.add(source.language)
    return answer.lines
  }

  return {
    tokenize(source, lines, deadlineMs) {
      const next = queue.then(
        () => run(source, lines, deadlineMs),
        () => run(source, lines, deadlineMs),
      )
      queue = next.catch(() => undefined)
      return next
    },
    failed: (extensionId) => failedExtensions.has(extensionId),
    onFailure(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
