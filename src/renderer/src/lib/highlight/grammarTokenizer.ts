import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { CODE_THEME, CODE_THEME_REGISTRATION, codeRoleOfColor, type CodeRole } from './codeTheme'

// What runs inside the grammar worker (grammarWorker.ts): an extension's
// TextMate grammar compiled and run by the same Shiki engine chat uses for
// Studio's own languages, off the window's thread, so a grammar that
// backtracks for minutes costs a worker the window terminates, never the
// window itself (grammarHost.ts holds the deadlines).
//
// The work comes in steps, each with a budget of its own on the host's side:
// the engine starting (`ready`, posted once it can serve), a grammar loading
// and compiling (`load`), and a slice of lines tokenized (`tokenize`), which
// may go on from where the last slice of the same document stopped.
//
// Each extension gets a highlighter, and so a grammar registry, of its own:
// a grammar's scope can never stand in for Studio's (which never load here)
// or for another extension's, whatever scope name it declares. Its own
// grammars may include each other.
//
// No DOM, no Node: it runs in a Web Worker in the app and in a worker thread
// in the tests.

export type GrammarRequest =
  | {
      type: 'load'
      id: number
      extensionId: string
      language: string
      /** The grammar, as its Studio checked and served it. */
      grammar: Record<string, unknown> & { scopeName: string }
    }
  | {
      type: 'tokenize'
      id: number
      extensionId: string
      language: string
      lines: readonly string[]
      /** A document's key: its grammar state is kept under it after the slice. */
      stateKey?: string
      /** Go on from the state the last slice under `stateKey` ended in, rather than a fresh one. */
      resume?: boolean
    }

/** Each line's tokens as `[offset, role]`, a role only where it changes. */
export type TokenLines = Array<Array<[number, CodeRole | null]>>

export type GrammarResponse =
  | { type: 'ready' }
  | { type: 'loaded'; id: number }
  | { type: 'tokens'; id: number; lines: TokenLines }
  | { type: 'failed'; id: number; message: string }

/** Lines longer than this are left plain, as Studio's own grammars leave them. */
export const GRAMMAR_LINE_MAX_CHARS = 1000
const LINE_TIME_LIMIT_MS = 50
/** The documents whose state is kept between slices. */
const MAX_KEPT_STATES = 32

type GrammarState = ReturnType<HighlighterCore['getLastGrammarState']>

export type GrammarTokenizer = {
  /** Resolves once the engine can serve: the worker posts `ready` then. */
  ready: Promise<void>
  handle(request: GrammarRequest): Promise<GrammarResponse>
}

export function createGrammarTokenizer(
  options: {
    /** The engine's own limit per line, checked between searches; the host's deadline is the one that holds. */
    lineTimeLimitMs?: number
  } = {},
): GrammarTokenizer {
  const lineTimeLimitMs = options.lineTimeLimitMs ?? LINE_TIME_LIMIT_MS
  const engine = createOnigurumaEngine(import('shiki/wasm'))
  const highlighters = new Map<string, Promise<HighlighterCore>>()
  const loaded = new Map<string, HighlighterCore>()
  const states = new Map<string, GrammarState | undefined>()
  const highlighterFor = (extensionId: string) => {
    let highlighter = highlighters.get(extensionId)
    if (!highlighter) {
      highlighter = createHighlighterCore({ themes: [CODE_THEME_REGISTRATION], langs: [], engine })
      highlighters.set(extensionId, highlighter)
    }
    return highlighter
  }
  // The engine and a highlighter exist: what every request needs before its budget starts.
  const ready = highlighterFor('').then(() => undefined)

  return {
    ready,
    async handle(request) {
      try {
        if (request.type === 'load') {
          const highlighter = await highlighterFor(request.extensionId)
          await highlighter.loadLanguage({ ...request.grammar, name: request.language } as never)
          // Compile its first scanners now, inside this step's budget.
          highlighter.codeToTokensBase('', { lang: request.language, theme: CODE_THEME })
          loaded.set(request.language, highlighter)
          return { type: 'loaded', id: request.id }
        }
        const highlighter = loaded.get(request.language)
        if (!highlighter) return { type: 'failed', id: request.id, message: 'The grammar is not loaded.' }
        const lines: TokenLines = []
        let state = request.resume && request.stateKey ? states.get(request.stateKey) : undefined
        for (const line of request.lines) {
          if (line.length > GRAMMAR_LINE_MAX_CHARS) {
            lines.push([[0, null]])
            continue
          }
          const tokens = highlighter.codeToTokensBase(line, {
            lang: request.language,
            theme: CODE_THEME,
            ...(state ? { grammarState: state } : {}),
            tokenizeTimeLimit: lineTimeLimitMs,
          })
          state = highlighter.getLastGrammarState(tokens) ?? state
          const out: Array<[number, CodeRole | null]> = []
          for (const token of tokens[0] ?? []) {
            const role = codeRoleOfColor(token.color)
            if (out.length === 0 || out[out.length - 1]![1] !== role) out.push([token.offset, role])
          }
          lines.push(out.length > 0 ? out : [[0, null]])
        }
        if (request.stateKey) {
          states.delete(request.stateKey)
          states.set(request.stateKey, state)
          while (states.size > MAX_KEPT_STATES) states.delete(states.keys().next().value!)
        }
        return { type: 'tokens', id: request.id, lines }
      } catch (error) {
        return { type: 'failed', id: request.id, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
