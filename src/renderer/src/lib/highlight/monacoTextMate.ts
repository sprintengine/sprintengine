import type * as Monaco from 'monaco-editor'
import type { HighlighterCore } from 'shiki/core'

import { CODE_THEME, loadCodeLanguage } from './codeHighlight'
import {
  activeContributedSyntaxes,
  contributedSyntaxContent,
  subscribeContributedSyntaxes,
  type ContributedSyntax,
} from './contributedSyntaxes'

// The editor's half of an extension's language: a bridge from the Shiki
// engine chat code blocks use to Monaco's tokens. Monaco highlights its own
// languages with Monarch, which cannot read a TextMate grammar; Shiki already
// runs TextMate grammars (its Oniguruma engine) for chat. So the editor asks
// the same engine, with the same grammar loaded once, for each line, carrying
// the grammar's state from line to line the way Monaco carries its own, and
// names each token by its code colour (comment, keyword, string, number,
// function, type): the names Monaco's themes colour. Chat and the editor agree
// on what each token is because one tokenizer decides it.
//
// Each line has the limits Studio's own grammars have in chat (50 ms of
// tokenizing; past it the rest of the line stays plain), and a grammar that
// fails to load leaves the file plain.

/** Shiki's colours in the code theme are `var(--sem-syntax-<role>)`; Monaco's token for each. */
const ROLE_TOKENS: Readonly<Record<string, string>> = {
  comment: 'comment',
  keyword: 'keyword',
  string: 'string',
  number: 'number',
  function: 'entity.name.function',
  type: 'type',
}

export function monacoTokenForColor(color: string | undefined): string {
  const role = color ? /^var\(--sem-syntax-([a-z]+)\)$/.exec(color)?.[1] : undefined
  return (role && ROLE_TOKENS[role]) ?? ''
}

type GrammarState = ReturnType<HighlighterCore['getLastGrammarState']>

type InternalStack = { equals(other: unknown): boolean }

/** A line's end state: the grammar's own, which Monaco compares to stop re-tokenizing below an edit. */
class LineState implements Monaco.languages.IState {
  constructor(readonly grammar: GrammarState | undefined) {}
  clone(): LineState {
    return this
  }
  equals(other: Monaco.languages.IState): boolean {
    if (!(other instanceof LineState)) return false
    if (other.grammar === this.grammar) return true
    const mine = (this.grammar as { getInternalStack?: () => InternalStack } | undefined)?.getInternalStack?.()
    const theirs = (other.grammar as { getInternalStack?: () => InternalStack } | undefined)?.getInternalStack?.()
    return Boolean(mine && theirs && mine.equals(theirs))
  }
}

/** Monaco's tokens provider for one language, over the engine that has its grammar loaded. */
export function textMateTokensProvider(engine: HighlighterCore, language: string): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => new LineState(undefined),
    tokenize(line, state) {
      const previous = (state as LineState).grammar
      try {
        const lines = engine.codeToTokensBase(line, {
          lang: language,
          theme: CODE_THEME,
          ...(previous ? { grammarState: previous } : {}),
          tokenizeTimeLimit: 50,
        })
        const tokens = (lines[0] ?? []).map((token) => ({
          startIndex: token.offset,
          scopes: monacoTokenForColor(token.color),
        }))
        return { tokens, endState: new LineState(engine.getLastGrammarState(lines) ?? previous) }
      } catch {
        return { tokens: [{ startIndex: 0, scopes: '' }], endState: state }
      }
    },
  }
}

const registered = new Set<string>()

function register(monaco: typeof Monaco, entry: ContributedSyntax): void {
  const { language, syntax } = entry
  monaco.languages.register({
    id: language,
    aliases: [syntax.title],
    ...(syntax.extensions ? { extensions: [...syntax.extensions] } : {}),
    ...(syntax.filenames ? { filenames: [...syntax.filenames] } : {}),
  })
  // Asked for the first time a model in this language is tokenized: the
  // grammar is fetched and loaded then, not when the extension arrives.
  monaco.languages.registerTokensProviderFactory(language, {
    create: async () => {
      const content = await contributedSyntaxContent(entry)
      const configuration = content.configuration
      if (configuration) {
        monaco.languages.setLanguageConfiguration(language, {
          ...(configuration.comments ? { comments: configuration.comments } : {}),
          ...(configuration.brackets ? { brackets: configuration.brackets } : {}),
          ...(configuration.autoClosingPairs ? { autoClosingPairs: configuration.autoClosingPairs } : {}),
          ...(configuration.surroundingPairs ? { surroundingPairs: configuration.surroundingPairs } : {}),
        })
      }
      return textMateTokensProvider(await loadCodeLanguage(language), language)
    },
  })
}

/**
 * Register every language the window's extensions contribute with Monaco, now
 * and as they arrive. Monaco cannot unregister a language: one whose extension
 * left stays known, and no file opens in it any more (files.ts asks the
 * registry, which no longer lists it).
 */
export function followContributedLanguages(monaco: typeof Monaco): () => void {
  const sync = () => {
    for (const entry of activeContributedSyntaxes()) {
      if (registered.has(entry.language)) continue
      registered.add(entry.language)
      register(monaco, entry)
    }
  }
  sync()
  return subscribeContributedSyntaxes(sync)
}
