import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, expect, test, vi } from 'vitest'

import { parseExtensionManifest } from '../../../../shared/modules/third-party-manifest'

// Which fences and files an extension's language colours, and how its tokens
// reach a chat code block and the editor. An extension adds languages: a
// fence, an alias or a suffix one of Studio's own grammars already handles
// stays Studio's. The tokenizing itself happens in the grammar worker
// (grammarHost.test.ts); here the worker's answer is stood in for.

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/content-sample')
const KEY = 'local.tally-language'
const sample = parseExtensionManifest(readFileSync(join(SAMPLE, 'extension.json'), 'utf8'))
if (!sample.ok) throw new Error('the sample extension does not validate')
const syntax = sample.manifest.contributes.syntaxes[0]!

const asked = vi.hoisted(() => ({ lines: [] as unknown[] }))
vi.mock('./grammarWorker?worker', () => ({
  default: class {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror = null
    postMessage(request: { id: number; lines: string[] }) {
      asked.lines.push(request.lines)
      // The worker's answer for `move 42`: a keyword, a space, a number.
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            id: request.id,
            ok: true,
            lines: request.lines.map(() => [
              [0, 'keyword'],
              [4, null],
              [5, 'number'],
            ]),
          },
        }),
      )
    }
    terminate() {}
  },
}))
vi.mock('../../studio/extensions', () => ({
  windowHasStudio: () => true,
  extensionsApi: {
    extensionContent: async () => ({ kind: 'syntax', grammar: { scopeName: 'source.tally', patterns: [] } }),
  },
}))

const { setContributedSyntaxes, contributedSyntaxForFile, contributedSyntaxForFence } =
  await import('./contributedSyntaxes')
const { normalizeCodeLanguage } = await import('./codeHighlight')
const { themedTokensOf, tokenizeContributed } = await import('./contributedHighlight')
const { encodeSemanticTokens, semanticTokensProvider } = await import('./monacoTextMate')
const { detectLanguage } = await import('../../utils/files')

const LANGUAGE = `ext.${KEY}.tally`

beforeEach(() => {
  setContributedSyntaxes([{ extensionId: KEY, extensionName: 'Tally language', syntaxes: [syntax] }])
})

test('a fence names a contributed language by its id or its suffix, and a file by its suffix', () => {
  expect(normalizeCodeLanguage('tally')).toBe(LANGUAGE)
  expect(contributedSyntaxForFence('TALLY')?.language).toBe(LANGUAGE)
  expect(contributedSyntaxForFile('books/2026.tally')?.language).toBe(LANGUAGE)
  expect(detectLanguage('books/2026.tally')).toBe(LANGUAGE)
  // A file named only the suffix is not one of its files.
  expect(contributedSyntaxForFile('.tally')).toBeUndefined()
})

test('an extension never takes a fence, alias or suffix Studio’s own grammars handle', () => {
  setContributedSyntaxes([
    {
      extensionId: KEY,
      extensionName: 'Tally language',
      syntaxes: [{ ...syntax, id: 'bash', extensions: ['.sh', '.py', '.yml', '.tally'] }],
    },
  ])
  // Fences: a bundled language, its alias, and a suffix that is one.
  expect(normalizeCodeLanguage('bash')).toBe('bash')
  expect(normalizeCodeLanguage('sh')).toBe('bash')
  expect(normalizeCodeLanguage('py')).toBe('python')
  expect(normalizeCodeLanguage('yml')).toBe('yaml')
  // Files Studio opens in a language of its own.
  expect(detectLanguage('run.sh')).toBe('shell')
  expect(detectLanguage('main.py')).toBe('python')
  expect(detectLanguage('main.ts')).toBe('typescript')
  // What Studio does not know stays the extension's.
  expect(normalizeCodeLanguage('tally')).toBe(`ext.${KEY}.bash`)
  expect(detectLanguage('a.tally')).toBe(`ext.${KEY}.bash`)
})

test('an extension switched off contributes no language', () => {
  setContributedSyntaxes([{ extensionId: KEY, extensionName: 'Tally language', syntaxes: [syntax] }], () => false)
  expect(normalizeCodeLanguage('tally')).toBeNull()
  expect(detectLanguage('a.tally')).toBe('plaintext')
})

test('a chat code block takes its colours from the worker’s answer', async () => {
  const tokens = await tokenizeContributed(LANGUAGE, ['move 42'], 1000)
  expect(asked.lines).toContainEqual(['move 42'])
  expect(themedTokensOf('move 42', tokens![0])).toEqual([
    { content: 'move', offset: 0, color: 'var(--sem-syntax-keyword)' },
    { content: ' ', offset: 4 },
    { content: '42', offset: 5, color: 'var(--sem-syntax-number)' },
  ])
})

test('the editor gets the same tokens as semantic tokens, and a document too large stays plain', async () => {
  expect(
    Array.from(
      encodeSemanticTokens(
        ['move 42', '', 'move 7'],
        [
          [
            [0, 'keyword'],
            [4, null],
            [5, 'number'],
          ],
          [[0, null]],
          [
            [0, 'keyword'],
            [4, null],
            [5, 'number'],
          ],
        ],
      ),
    ),
  ).toEqual([
    // line, start, length, type (keyword = 1, number = 3), modifiers; relative to the token before
    0, 0, 4, 1, 0, 0, 5, 2, 3, 0, 2, 0, 4, 1, 0, 0, 5, 1, 3, 0,
  ])
  const provider = semanticTokensProvider(LANGUAGE)
  const model = (text: string) => ({ getValue: () => text, getLineCount: () => text.split('\n').length }) as never
  const tokens = await provider.provideDocumentSemanticTokens(model('move 42'), null, {} as never)
  expect(tokens && 'data' in tokens ? Array.from(tokens.data) : null).toEqual([0, 0, 4, 1, 0, 0, 5, 2, 3, 0])
  expect(await provider.provideDocumentSemanticTokens(model('x'.repeat(500_001)), null, {} as never)).toBeNull()
})
