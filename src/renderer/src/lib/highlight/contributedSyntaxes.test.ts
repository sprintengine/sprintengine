import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { parseTextMateGrammar } from '../../../../../packages/extension-sdk/src/content-syntaxes'
import { parseExtensionManifest } from '../../../../shared/modules/third-party-manifest'

// An extension's TextMate grammar, as the window's Studio serves it, colours a
// chat code block fenced in its language and a file the editor opens in it,
// through the one Shiki engine both use; the editor's tokens come from that
// engine over Monaco's line-by-line contract. Studio's own languages that
// drive completions are never replaced.

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/content-sample')
const KEY = 'local.tally-language'
const sample = parseExtensionManifest(readFileSync(join(SAMPLE, 'extension.json'), 'utf8'))
if (!sample.ok) throw new Error('the sample extension does not validate')
const syntax = sample.manifest.contributes.syntaxes[0]!
const grammar = parseTextMateGrammar(readFileSync(join(SAMPLE, syntax.path), 'utf8'), syntax.scopeName)
if (!grammar.ok) throw new Error('the sample grammar does not validate')

const served = vi.hoisted(() => ({ requests: [] as unknown[] }))
vi.mock('../../studio/extensions', () => ({
  windowHasStudio: () => true,
  extensionsApi: {
    extensionContent: async (request: unknown) => {
      served.requests.push(request)
      return { kind: 'syntax', grammar: grammarForMock(), configuration: { comments: { lineComment: '#' } } }
    },
  },
}))
// Read lazily: the mock factory is hoisted above this module's own setup.
function grammarForMock() {
  return (globalThis as { __tallyGrammar?: unknown }).__tallyGrammar
}
;(globalThis as { __tallyGrammar?: unknown }).__tallyGrammar = grammar.grammar

const { setContributedSyntaxes, contributedSyntaxForFile, contributedSyntaxForFence } =
  await import('./contributedSyntaxes')
const { IncrementalCodeTokenizer, loadCodeLanguage, normalizeCodeLanguage } = await import('./codeHighlight')
const { textMateTokensProvider, monacoTokenForColor } = await import('./monacoTextMate')
const { detectLanguage } = await import('../../utils/files')

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(0)
  setContributedSyntaxes([{ extensionId: KEY, extensionName: 'Tally language', syntaxes: [syntax] }])
})
afterEach(() => {
  vi.restoreAllMocks()
})

const LANGUAGE = `ext.${KEY}.tally`

test('a fence names a contributed language by its id or its suffix, and a file by its suffix', () => {
  expect(normalizeCodeLanguage('tally')).toBe(LANGUAGE)
  expect(contributedSyntaxForFence('TALLY')?.language).toBe(LANGUAGE)
  expect(contributedSyntaxForFile('books/2026.tally')?.language).toBe(LANGUAGE)
  expect(detectLanguage('books/2026.tally')).toBe(LANGUAGE)
  expect(detectLanguage('notes.md')).toBe('markdown')
  // A file named only the suffix is not one of its files.
  expect(contributedSyntaxForFile('.tally')).toBeUndefined()
})

test('Studio’s languages that drive completions are never replaced; others are', () => {
  setContributedSyntaxes([
    {
      extensionId: KEY,
      extensionName: 'Tally language',
      syntaxes: [{ ...syntax, id: 'python', extensions: ['.ts', '.py'] }],
    },
  ])
  expect(detectLanguage('main.ts')).toBe('typescript')
  expect(normalizeCodeLanguage('ts')).toBe('typescript')
  expect(detectLanguage('main.py')).toBe(`ext.${KEY}.python`)
  expect(normalizeCodeLanguage('python')).toBe(`ext.${KEY}.python`)
})

test('an extension switched off contributes no language', () => {
  setContributedSyntaxes([{ extensionId: KEY, extensionName: 'Tally language', syntaxes: [syntax] }], () => false)
  expect(normalizeCodeLanguage('tally')).toBeNull()
  expect(detectLanguage('a.tally')).toBe('plaintext')
})

test('a chat code block in the contributed language is coloured by its grammar', async () => {
  const language = normalizeCodeLanguage('tally')!
  const engine = await loadCodeLanguage(language)
  const [line, comment] = new IncrementalCodeTokenizer(engine, language).update(
    'move 42.50 from Household:Shared to "rent"\n# paid',
    true,
  )
  const colourOf = (text: string) => line!.tokens.find((token) => token.content.includes(text))?.color
  expect(colourOf('move')).toBe('var(--sem-syntax-keyword)')
  expect(colourOf('42.50')).toBe('var(--sem-syntax-number)')
  expect(colourOf('Household')).toBe('var(--sem-syntax-type)')
  expect(colourOf('rent')).toBe('var(--sem-syntax-string)')
  expect(comment!.tokens[0]!.color).toBe('var(--sem-syntax-comment)')
  expect(served.requests).toContainEqual({ moduleId: KEY, kind: 'syntax', id: 'tally' })
})

test('the editor gets the same tokens, line by line, carrying the grammar’s state across lines', async () => {
  const language = normalizeCodeLanguage('tally')!
  const provider = textMateTokensProvider(await loadCodeLanguage(language), language)
  const first = provider.tokenize('move 3 to "open', provider.getInitialState())
  const scopes = (result: typeof first, line: string) =>
    result.tokens.map((token, index) => [
      line.slice(token.startIndex, result.tokens[index + 1]?.startIndex ?? line.length),
      token.scopes,
    ])
  expect(scopes(first, 'move 3 to "open')).toEqual([
    ['move', 'keyword'],
    [' ', ''],
    ['3', 'number'],
    [' ', ''],
    ['to', 'keyword'],
    [' ', ''],
    ['"open', 'string'],
  ])
  // The string left open runs on into the next line.
  const second = provider.tokenize('still" move', first.endState)
  expect(scopes(second, 'still" move')).toEqual([
    ['still"', 'string'],
    [' ', ''],
    ['move', 'keyword'],
  ])
  // A line that ends where it began ends in the same state, so Monaco stops re-tokenizing there.
  const again = provider.tokenize('move 3', provider.getInitialState())
  expect(again.endState.equals(provider.tokenize('move 4', provider.getInitialState()).endState)).toBe(true)
  expect(first.endState.equals(again.endState)).toBe(false)
  expect(monacoTokenForColor('var(--sem-syntax-function)')).toBe('entity.name.function')
  expect(monacoTokenForColor('#ffffff')).toBe('')
})
