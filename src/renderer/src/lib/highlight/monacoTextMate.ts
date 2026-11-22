import type * as Monaco from 'monaco-editor'

import { CODE_ROLES, type CodeRole } from './codeTheme'
import {
  DOCUMENT_DEADLINE_MS,
  DOCUMENT_MAX_CHARS,
  DOCUMENT_MAX_LINES,
  tokenizeContributed,
} from './contributedHighlight'
import {
  activeContributedSyntaxes,
  contributedSyntaxContent,
  subscribeContributedSyntaxes,
  type ContributedSyntax,
} from './contributedSyntaxes'
import type { TokenLines } from './grammarHost'

// The editor's half of an extension's language. Monaco highlights its own
// languages with Monarch, which cannot read a TextMate grammar, and its
// tokens providers are synchronous, so they would run an extension's grammar
// on the window's thread. Instead the document is tokenized whole in the
// grammar worker (grammarHost.ts, the same worker chat code blocks use, with
// its deadline), and the answer comes back to Monaco as semantic tokens named
// by their code colour (comment, keyword, string, number, function, type), the
// names Monaco's themes colour. While a pass runs the previous colours stay,
// shifted by the edits; a document past 500,000 characters or 20,000 lines,
// and one whose extension's grammar failed, stays plain.

/** Monaco's semantic token type for each role, by the role's index in the legend. */
const TOKEN_TYPES: Readonly<Record<CodeRole, string>> = {
  comment: 'comment',
  keyword: 'keyword',
  string: 'string',
  number: 'number',
  function: 'function',
  type: 'type',
}

export const SEMANTIC_LEGEND = { tokenTypes: CODE_ROLES.map((role) => TOKEN_TYPES[role]), tokenModifiers: [] }

/** Monaco's relative encoding of the worker's tokens: line, start, length, type, modifiers. */
export function encodeSemanticTokens(lines: readonly string[], tokens: TokenLines): Uint32Array {
  const data: number[] = []
  let previousLine = 0
  let previousStart = 0
  tokens.forEach((line, lineIndex) => {
    const text = lines[lineIndex] ?? ''
    line.forEach(([offset, role], index) => {
      if (!role) return
      const end = line[index + 1]?.[0] ?? text.length
      if (end <= offset) return
      const deltaLine = lineIndex - previousLine
      data.push(deltaLine, deltaLine === 0 ? offset - previousStart : offset, end - offset, CODE_ROLES.indexOf(role), 0)
      previousLine = lineIndex
      previousStart = offset
    })
  })
  return new Uint32Array(data)
}

/** The provider: a document's tokens from the worker, or none for it to stay plain. */
export function semanticTokensProvider(language: string): Monaco.languages.DocumentSemanticTokensProvider {
  return {
    getLegend: () => SEMANTIC_LEGEND,
    async provideDocumentSemanticTokens(model) {
      const text = model.getValue()
      if (text.length > DOCUMENT_MAX_CHARS || model.getLineCount() > DOCUMENT_MAX_LINES) return null
      const lines = text.split(/\r?\n/)
      const tokens = await tokenizeContributed(language, lines, DOCUMENT_DEADLINE_MS)
      return tokens ? { data: encodeSemanticTokens(lines, tokens) } : null
    },
    releaseDocumentSemanticTokens() {},
  }
}

const registered = new Set<string>()

function register(monaco: typeof Monaco, entry: ContributedSyntax): void {
  const { language, syntax } = entry
  // No suffixes or names here: Studio picks every editor's language itself
  // (utils/files.ts), and never hands one of its own to an extension.
  monaco.languages.register({ id: language, aliases: [syntax.title] })
  monaco.languages.registerDocumentSemanticTokensProvider(language, semanticTokensProvider(language))
  // The configuration (comments, brackets, pairs) is data: read on the
  // window's thread, once, when a model in the language first appears.
  monaco.languages.onLanguageEncountered(language, () => {
    void contributedSyntaxContent(entry).then(
      ({ configuration }) => {
        if (!configuration) return
        monaco.languages.setLanguageConfiguration(language, {
          ...(configuration.comments ? { comments: configuration.comments } : {}),
          ...(configuration.brackets ? { brackets: configuration.brackets } : {}),
          ...(configuration.autoClosingPairs ? { autoClosingPairs: configuration.autoClosingPairs } : {}),
          ...(configuration.surroundingPairs ? { surroundingPairs: configuration.surroundingPairs } : {}),
        })
      },
      () => undefined,
    )
  })
}

/**
 * Register every language the window's extensions contribute with Monaco, now
 * and as they arrive, and turn on semantic colouring, which is how they are
 * drawn. Monaco cannot unregister a language: one whose extension left stays
 * known, and no file opens in it any more (files.ts asks the registry, which
 * no longer lists it).
 */
export function followContributedLanguages(monaco: typeof Monaco): () => void {
  // Heard while the editor is still being built, before it holds the
  // configuration an option is written to, so the option is set a tick later.
  const editors = monaco.editor.onDidCreateEditor((editor) => {
    queueMicrotask(() => editor.updateOptions({ 'semanticHighlighting.enabled': true } as Monaco.editor.IEditorOptions))
  })
  const sync = () => {
    for (const entry of activeContributedSyntaxes()) {
      if (registered.has(entry.language)) continue
      registered.add(entry.language)
      register(monaco, entry)
    }
  }
  sync()
  const stop = subscribeContributedSyntaxes(sync)
  return () => {
    stop()
    editors.dispose()
  }
}
