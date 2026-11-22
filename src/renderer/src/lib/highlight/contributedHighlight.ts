import type { ThemedToken } from 'shiki/core'

import { showToast } from '../../store/toastStore'
import { colorOfCodeRole } from './codeTheme'
import { contributedSyntax, contributedSyntaxContent } from './contributedSyntaxes'
import {
  createGrammarHost,
  type GrammarHost,
  type GrammarSource,
  type GrammarWorker as GrammarWorkerHandle,
  type TokenLines,
} from './grammarHost'
import GrammarWorker from './grammarWorker?worker'

// The window's one grammar host (grammarHost.ts), for chat code blocks and
// the editor alike, over the worker that runs extensions' grammars. A block
// in chat has a second to be coloured, a document in the editor two; past
// that its extension's highlighting stops for the session and the person is
// told which extension it was.

/** A chat code block's budget. */
export const CODE_BLOCK_DEADLINE_MS = 1000
/** An editor document's budget. */
export const DOCUMENT_DEADLINE_MS = 2000
/** The most of a document the editor asks to be coloured; beyond it, the file stays plain. */
export const DOCUMENT_MAX_CHARS = 500_000
export const DOCUMENT_MAX_LINES = 20_000

let host: GrammarHost | null = null

function grammarHost(): GrammarHost {
  if (host) return host
  host = createGrammarHost({
    spawn: () => new GrammarWorker({ name: 'extension-grammars' }) as unknown as GrammarWorkerHandle,
  })
  host.onFailure((failure) =>
    showToast({
      tone: 'warn',
      title: `${failure.extensionName}’s highlighting stopped`,
      description: failure.message,
    }),
  )
  return host
}

function sourceOf(language: string): GrammarSource | null {
  const entry = contributedSyntax(language)
  if (!entry) return null
  return {
    extensionId: entry.extensionId,
    extensionName: entry.extensionName,
    language,
    grammar: async () => (await contributedSyntaxContent(entry)).grammar,
  }
}

/** Whether a language name is an extension's (`ext.<install key>.<id>`). */
export function isContributedLanguage(language: string): boolean {
  return language.startsWith('ext.')
}

/** Tokenize lines of a contributed language in the worker; null leaves them plain. */
export function tokenizeContributed(
  language: string,
  lines: readonly string[],
  deadlineMs: number,
): Promise<TokenLines | null> {
  const source = sourceOf(language)
  return source ? grammarHost().tokenize(source, lines, deadlineMs) : Promise.resolve(null)
}

/** A line's text cut into tokens at the offsets the worker gave, coloured by role. */
export function themedTokensOf(text: string, tokens: TokenLines[number] | undefined): ThemedToken[] {
  if (!tokens || tokens.length === 0) return [{ content: text, offset: 0 }]
  return tokens.map(([offset, role], index) => ({
    content: text.slice(offset, tokens[index + 1]?.[0] ?? text.length),
    offset,
    ...(role ? { color: colorOfCodeRole(role) } : {}),
  }))
}
