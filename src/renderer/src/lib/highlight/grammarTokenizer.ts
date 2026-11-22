import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { CODE_THEME, CODE_THEME_REGISTRATION, codeRoleOfColor, type CodeRole } from './codeTheme'

// What runs inside the grammar worker (grammarWorker.ts): an extension's
// TextMate grammar compiled and run by the same Shiki engine chat uses for
// Studio's own languages, off the window's thread, so a grammar that
// backtracks for minutes costs a worker the window terminates, never the
// window itself (grammarHost.ts holds the deadline).
//
// Each extension gets a highlighter, and so a grammar registry, of its own:
// a grammar's scope can never stand in for Studio's (which never load here)
// or for another extension's, whatever scope name it declares. Its own
// grammars may include each other.
//
// No DOM, no Node: it runs in a Web Worker in the app and in a worker thread
// in the tests.

/** One request: tokenize `lines` in `language`, its grammar sent with it the first time. */
export type GrammarRequest = {
  id: number
  extensionId: string
  language: string
  /** The grammar, as its Studio checked and served it; sent once per worker. */
  grammar?: Record<string, unknown> & { scopeName: string }
  lines: readonly string[]
}

/** Each line's tokens as `[offset, role]`, a role only where it changes; or why there are none. */
export type GrammarResponse =
  { id: number; ok: true; lines: Array<Array<[number, CodeRole | null]>> } | { id: number; ok: false; message: string }

/** Lines longer than this are left plain, as Studio's own grammars leave them. */
export const GRAMMAR_LINE_MAX_CHARS = 1000
const LINE_TIME_LIMIT_MS = 50

export type GrammarTokenizer = { handle(request: GrammarRequest): Promise<GrammarResponse> }

export function createGrammarTokenizer(): GrammarTokenizer {
  const engine = createOnigurumaEngine(import('shiki/wasm'))
  const highlighters = new Map<string, Promise<HighlighterCore>>()
  const loaded = new Set<string>()
  const highlighterFor = (extensionId: string) => {
    let highlighter = highlighters.get(extensionId)
    if (!highlighter) {
      highlighter = createHighlighterCore({ themes: [CODE_THEME_REGISTRATION], langs: [], engine })
      highlighters.set(extensionId, highlighter)
    }
    return highlighter
  }
  return {
    async handle(request) {
      try {
        const highlighter = await highlighterFor(request.extensionId)
        if (!loaded.has(request.language)) {
          if (!request.grammar) return { id: request.id, ok: false, message: 'The grammar was not sent.' }
          await highlighter.loadLanguage({ ...request.grammar, name: request.language } as never)
          loaded.add(request.language)
        }
        const lines: Array<Array<[number, CodeRole | null]>> = []
        let state: ReturnType<HighlighterCore['getLastGrammarState']> | undefined
        for (const line of request.lines) {
          if (line.length > GRAMMAR_LINE_MAX_CHARS) {
            lines.push([[0, null]])
            continue
          }
          const tokens = highlighter.codeToTokensBase(line, {
            lang: request.language,
            theme: CODE_THEME,
            ...(state ? { grammarState: state } : {}),
            tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
          })
          state = highlighter.getLastGrammarState(tokens) ?? state
          const out: Array<[number, CodeRole | null]> = []
          for (const token of tokens[0] ?? []) {
            const role = codeRoleOfColor(token.color)
            if (out.length === 0 || out[out.length - 1]![1] !== role) out.push([token.offset, role])
          }
          lines.push(out.length > 0 ? out : [[0, null]])
        }
        return { id: request.id, ok: true, lines }
      } catch (error) {
        return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
