// What a content extension contributes (syntaxes, keybindings, status bar
// items and settings): each point's checks in extension.json, the grammar and
// language configuration files a syntax names, and the SDK's sample content
// extension, which must pass all of them as content alone.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import {
  extensionSettingDefaults,
  extensionSettingValues,
  keybindingProblem,
  parseExtensionManifest,
  requiredExtensionTier,
  settingValueProblem,
  validateExtensionManifest,
  type ExtensionSettingContribution,
} from '../src/extension-manifest.js'
import {
  GRAMMAR_MAX_BYTES,
  parseLanguageConfiguration,
  parseTextMateGrammar,
  validateLanguageConfiguration,
  validateTextMateGrammar,
} from '../src/content-syntaxes.js'

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/content-sample')

function manifest(contributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'sample',
    version: '1.0.0',
    engines: { studio: '>=0.13.0' },
    tier: 'content',
    name: 'Sample',
    contributes,
    ...extra,
  }
}

function issues(value: unknown): string[] {
  const result = validateExtensionManifest(value)
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`)
}

test('the sample content extension is content alone, and its files pass', () => {
  const parsed = parseExtensionManifest(readFileSync(join(SAMPLE, 'extension.json'), 'utf8'), { authoring: true })
  expect(parsed.ok ? [] : parsed.issues).toEqual([])
  if (!parsed.ok) return
  const { contributes } = parsed.manifest
  expect(parsed.manifest.tier).toBe('content')
  expect(requiredExtensionTier(parsed.manifest)).toBe('content')
  expect(contributes.syntaxes).toHaveLength(1)
  expect(contributes.keybindings).toHaveLength(1)
  expect(contributes.statusBarItems).toHaveLength(1)
  expect(contributes.settings.length).toBeGreaterThan(0)
  const [syntax] = contributes.syntaxes
  const grammar = parseTextMateGrammar(readFileSync(join(SAMPLE, syntax!.path), 'utf8'), syntax!.scopeName)
  expect(grammar.ok).toBe(true)
  const configuration = parseLanguageConfiguration(readFileSync(join(SAMPLE, syntax!.configuration!), 'utf8'))
  expect(configuration.ok).toBe(true)
})

test('the four points are content, so they ask for nothing', () => {
  const value = manifest({
    syntaxes: [{ id: 'gleam', title: 'Gleam', scopeName: 'source.gleam', path: 'g.json' }],
    keybindings: [{ command: 'panel.git.toggle', key: 'Mod+Alt+G' }],
    statusBarItems: [{ id: 'state', text: 'Ready' }],
    settings: [{ key: 'url', title: 'URL', type: 'string' }],
  })
  expect(issues(value)).toEqual([])
})

test('a syntax names a JSON grammar, a dotted scope unique in the extension, and portable names', () => {
  const base = { id: 'gleam', title: 'Gleam', scopeName: 'source.gleam', path: 'g.json' }
  expect(issues(manifest({ syntaxes: [{ ...base, scopeName: 'gleam' }] }))[0]).toMatch(/scopeName: must be a dotted/)
  expect(issues(manifest({ syntaxes: [{ ...base, path: 'g.tmLanguage' }] }))[0]).toMatch(/path: must end in \.json/)
  expect(issues(manifest({ syntaxes: [{ ...base, path: '../g.json' }] }))[0]).toMatch(/relative path inside/)
  expect(issues(manifest({ syntaxes: [{ ...base, extensions: ['gleam'] }] }))[0]).toMatch(/suffix with its dot/)
  expect(issues(manifest({ syntaxes: [{ ...base, filenames: ['a/b.toml'] }] }))[0]).toMatch(/file name/)
  expect(issues(manifest({ syntaxes: [base, { ...base, id: 'other' }] }))).toEqual([
    'contributes.syntaxes[1].scopeName: duplicate scope: source.gleam.',
  ])
})

test('a keybinding is a modified key bound to an own command or a Studio action', () => {
  expect(keybindingProblem('Mod+Shift+K')).toBeNull()
  expect(keybindingProblem('Ctrl+Alt+Enter')).toBeNull()
  expect(keybindingProblem('F6')).toBeNull()
  expect(keybindingProblem('Mod+Alt++')).toBeNull()
  expect(keybindingProblem('K')).toMatch(/modifier other than Shift/)
  expect(keybindingProblem('Shift+K')).toMatch(/modifier other than Shift/)
  expect(keybindingProblem('Hyper+K')).toMatch(/modifier Studio does not know/)
  expect(keybindingProblem('Mod+Mod+K')).toMatch(/twice/)
  expect(keybindingProblem('Mod+KK')).toMatch(/one key/)

  expect(issues(manifest({ keybindings: [{ command: 'notes.clear', key: 'Mod+K' }] }))).toEqual([
    'contributes.keybindings[0].command: names neither a contributed command nor a Studio command action: notes.clear.',
  ])
  // An own command is declarative, so the extension is declarative too.
  const own = manifest(
    {
      commands: [{ id: 'notes.open', title: 'Open', action: 'panel.files.toggle' }],
      keybindings: [{ command: 'notes.open', key: 'Mod+K' }],
    },
    { tier: 'declarative' },
  )
  expect(issues(own)).toEqual([])
  expect(
    issues(
      manifest({
        keybindings: [
          { command: 'panel.git.toggle', key: 'Mod+K' },
          { command: 'chat.new', key: 'mod+k' },
        ],
      }),
    ),
  ).toEqual(['contributes.keybindings[1]: duplicate key: mod+k.'])
})

test('a status bar item shows text or an icon, and runs a command it may run', () => {
  expect(issues(manifest({ statusBarItems: [{ id: 'a' }] }))).toEqual([
    'contributes.statusBarItems[0]: must give text, an icon, or both.',
  ])
  expect(issues(manifest({ statusBarItems: [{ id: 'a', icon: 'notes', command: 'chat.new' }] }))).toEqual([])
  expect(issues(manifest({ statusBarItems: [{ id: 'a', icon: 'rocket' }] }))[0]).toMatch(/icon: must be one of/)
  expect(issues(manifest({ statusBarItems: [{ id: 'a', text: 'x', command: 'not.mine' }] }))[0]).toMatch(
    /names neither a contributed command/,
  )
})

test('a setting declares a type, and its default, choices and bounds fit it', () => {
  const setting = (over: Record<string, unknown>) => manifest({ settings: [{ key: 'k', title: 'K', ...over }] })
  expect(issues(setting({ type: 'string', default: 3 }))).toEqual(['contributes.settings[0].default: must be text.'])
  expect(issues(setting({ type: 'integer', default: 1.5 }))).toEqual([
    'contributes.settings[0].default: must be a whole number.',
  ])
  expect(issues(setting({ type: 'number', minimum: 5, maximum: 1 }))).toEqual([
    'contributes.settings[0].minimum: must not be above maximum.',
  ])
  expect(issues(setting({ type: 'string', enum: ['a', 'b'], enumLabels: ['A'] }))).toEqual([
    'contributes.settings[0].enumLabels: must give one label per enum value.',
  ])
  expect(issues(setting({ type: 'string', enum: ['a'], default: 'b' }))).toEqual([
    'contributes.settings[0].default: must be one of: "a".',
  ])
  expect(issues(setting({ type: 'boolean', minimum: 1 }))).toEqual([
    'contributes.settings[0].minimum: applies to numbers only.',
  ])
  expect(issues(setting({ type: 'object' }))[0]).toMatch(/type: must be one of: string, number, integer, boolean/)
  expect(
    issues(
      manifest({
        settings: [
          { key: 'k', title: 'K', type: 'string' },
          { key: 'k', title: 'L', type: 'string' },
        ],
      }),
    ),
  ).toEqual(['contributes.settings[1]: duplicate key: k.'])
})

test('a value is held to its setting, and defaults are read by key', () => {
  const indent: ExtensionSettingContribution = {
    key: 'indent',
    title: 'Indent',
    type: 'integer',
    minimum: 1,
    maximum: 8,
    default: 2,
  }
  const name: ExtensionSettingContribution = { key: 'name', title: 'Name', type: 'string', maxLength: 4 }
  expect(settingValueProblem(indent, 4)).toBeNull()
  expect(settingValueProblem(indent, 9)).toBe('must be at most 8.')
  expect(settingValueProblem(indent, '4')).toBe('must be a number.')
  expect(settingValueProblem(name, 'abcde')).toBe('must be at most 4 characters.')
  expect(settingValueProblem(name, 'a\nb')).toBe('must be one line.')
  expect(extensionSettingDefaults([indent, name])).toEqual({ indent: 2 })
})

test('a grammar keeps only what a TextMate engine reads, and every include it names resolves', () => {
  const grammar = {
    scopeName: 'source.x',
    uuid: 'drop me',
    patterns: [{ include: '#word' }, { include: '$self' }, { include: 'source.js' }],
    repository: { word: { name: 'keyword.x', match: '\\bword\\b', comment: 'dropped' } },
  }
  const result = validateTextMateGrammar(grammar, 'source.x')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.grammar).toEqual({
    scopeName: 'source.x',
    patterns: [{ include: '#word' }, { include: '$self' }, { include: 'source.js' }],
    repository: { word: { name: 'keyword.x', match: '\\bword\\b' } },
  })

  const refused = (value: unknown, scope = 'source.x') => {
    const answer = validateTextMateGrammar(value, scope)
    return answer.ok ? [] : answer.issues.map((issue) => `${issue.path}: ${issue.message}`)
  }
  expect(refused(grammar, 'source.y')).toEqual([
    'scopeName: must be "source.y", the scope its extension.json declares.',
  ])
  expect(refused({ scopeName: 'source.x', patterns: [{ include: '#missing' }] })).toEqual([
    'patterns[0].include: names no repository rule: #missing.',
  ])
  expect(refused({ scopeName: 'source.x' })).toEqual(['patterns: is required: the rules the grammar starts from.'])
  expect(refused({ scopeName: 'source.x', patterns: [{ match: 42 }] })).toEqual([
    'patterns[0].match: must be a string.',
  ])
  expect(refused({ scopeName: 'source.x', patterns: [], repository: { constructor: {} } })).toEqual([
    'repository.constructor: is a reserved name.',
  ])
  let deep: Record<string, unknown> = { match: 'x' }
  for (let level = 0; level < 70; level += 1) deep = { patterns: [deep] }
  expect(refused({ scopeName: 'source.x', patterns: [deep] })[0]).toMatch(/nests deeper than 64/)
  expect(parseTextMateGrammar(' '.repeat(GRAMMAR_MAX_BYTES + 1), 'source.x').ok).toBe(false)
  expect(parseTextMateGrammar('{ not json', 'source.x').ok).toBe(false)
})

test('a language configuration keeps its markers and pairs, short and on one line', () => {
  const result = validateLanguageConfiguration({
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}']],
    autoClosingPairs: [{ open: '"', close: '"' }, ['(', ')']],
    surroundingPairs: [['[', ']']],
    wordPattern: 'ignored',
  })
  expect(result).toEqual({
    ok: true,
    configuration: {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [['{', '}']],
      autoClosingPairs: [
        { open: '"', close: '"' },
        { open: '(', close: ')' },
      ],
      surroundingPairs: [{ open: '[', close: ']' }],
    },
  })
  expect(validateLanguageConfiguration({ autoClosingPairs: [['<<<<<<<<<', '>']] }).ok).toBe(false)
  expect(validateLanguageConfiguration({ comments: { lineComment: 'a\nb' } }).ok).toBe(false)
})

test('a key the system or the browser keeps is refused', () => {
  for (const chord of [
    'Mod+C',
    'Mod+V',
    'Mod+X',
    'Mod+A',
    'Mod+Z',
    'Mod+Shift+Z',
    'Ctrl+Y',
    'Cmd+Q',
    'Mod+W',
    'Mod+R',
    'Mod+T',
    'Mod+N',
    'Mod+Shift+T',
    'Mod+F',
    'Mod+P',
    'Mod+S',
    'F5',
    'Shift+F5',
    'F11',
    'F12',
    'Alt+F4',
    'Mod+Alt+I',
  ])
    expect(keybindingProblem(chord), chord).toMatch(/system or the browser keeps/)
  for (const chord of ['Mod+Alt+U', 'Mod+Shift+K', 'Ctrl+Alt+C', 'F6', 'Mod+Shift+Y'])
    expect(keybindingProblem(chord), chord).toBeNull()
})

test('a grammar whose includes double at each level is refused before it can run', () => {
  // Each rule includes the one below it twice: 1.6 KB of JSON that expands to
  // 2^26 rules, which no deadline inside the engine interrupts.
  const repository: Record<string, unknown> = { r0: { match: 'a', name: 'keyword.x' } }
  for (let level = 1; level <= 26; level += 1)
    repository[`r${level}`] = { patterns: [{ include: `#r${level - 1}` }, { include: `#r${level - 1}` }] }
  const doubling = validateTextMateGrammar(
    { scopeName: 'source.x', patterns: [{ include: '#r26' }], repository },
    'source.x',
  )
  expect(doubling.ok).toBe(false)
  if (!doubling.ok) expect(doubling.issues[0]!.message).toMatch(/expands, include by include, to more than 10000 rules/)

  // A grammar that includes itself, as nested blocks do, is normal and passes.
  const recursive = validateTextMateGrammar(
    {
      scopeName: 'source.x',
      patterns: [{ include: '#block' }],
      repository: { block: { begin: '\\{', end: '\\}', patterns: [{ include: '#block' }, { include: '$self' }] } },
    },
    'source.x',
  )
  expect(recursive.ok).toBe(true)
})

test('a stored value is read while it fits its setting, and its default once it no longer does', () => {
  const indent: ExtensionSettingContribution = {
    key: 'indent',
    title: 'Indent',
    type: 'integer',
    minimum: 1,
    maximum: 8,
    default: 2,
  }
  const url: ExtensionSettingContribution = { key: 'url', title: 'URL', type: 'string' }
  expect(extensionSettingValues([indent, url], { indent: 4, url: 'https://example.com', other: true })).toEqual({
    indent: 4,
    url: 'https://example.com',
  })
  // Kept from before an update narrowed the range, or written past Studio.
  expect(extensionSettingValues([indent, url], { indent: 12, url: 7 })).toEqual({ indent: 2 })
})
