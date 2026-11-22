// The syntaxes a content extension contributes (`contributes.syntaxes`): a
// TextMate grammar in JSON, the format code editors and highlighters share, so
// an author publishes one grammar to more than one app, and optionally a
// language configuration (comment markers, brackets, auto-closing pairs).
//
// A grammar is data the highlighter interprets, never code: only the keys a
// TextMate engine reads are kept, each of the type it reads, inside size and
// depth limits. The same checks run in the author's tools, at install and each
// time Studio serves the file. Pure (no Node or DOM APIs).

import type { ManifestIssue } from './manifest-schema.js'

/** The largest grammar file Studio reads. */
export const GRAMMAR_MAX_BYTES = 1024 * 1024
/** The largest language configuration file Studio reads. */
export const LANGUAGE_CONFIGURATION_MAX_BYTES = 64 * 1024
const MAX_DEPTH = 64
const MAX_RULES = 20_000
const MAX_REGEX_CHARS = 16_384

/** A grammar's root scope: dotted words, such as `source.gleam`. */
export const SCOPE_NAME_RE = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)+$/

export type TextMateGrammar = Record<string, unknown> & { scopeName: string }

export type GrammarResult = { ok: true; grammar: TextMateGrammar } | { ok: false; issues: ManifestIssue[] }

// The keys a TextMate engine reads, and how. Everything else (`uuid`,
// `information_for_contributors`, `$schema`, comments) is dropped.
const STRING_KEYS = new Set(['name', 'contentName', 'match', 'begin', 'end', 'while', 'include', 'injectionSelector'])
const REGEX_KEYS = new Set(['match', 'begin', 'end', 'while', 'firstLineMatch'])
const ROOT_STRING_KEYS = new Set(['scopeName', 'firstLineMatch'])
const CAPTURE_KEYS = new Set(['captures', 'beginCaptures', 'endCaptures', 'whileCaptures'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Walk = { issues: ManifestIssue[]; rules: number; repositoryNames: Set<string>; includes: Array<[string, string]> }

function cleanRule(value: unknown, path: string, depth: number, walk: Walk): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    walk.issues.push({ path, message: 'must be a rule object.' })
    return undefined
  }
  if (depth > MAX_DEPTH) {
    walk.issues.push({ path, message: `nests deeper than ${MAX_DEPTH} levels.` })
    return undefined
  }
  walk.rules += 1
  if (walk.rules > MAX_RULES) {
    if (walk.rules === MAX_RULES + 1)
      walk.issues.push({ path, message: `the grammar holds more than ${MAX_RULES} rules.` })
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const at = `${path}.${key}`
    if (STRING_KEYS.has(key) || (depth === 0 && ROOT_STRING_KEYS.has(key))) {
      if (typeof raw !== 'string') {
        walk.issues.push({ path: at, message: 'must be a string.' })
        continue
      }
      if (REGEX_KEYS.has(key) && raw.length > MAX_REGEX_CHARS) {
        walk.issues.push({ path: at, message: `is a pattern longer than ${MAX_REGEX_CHARS} characters.` })
        continue
      }
      if (key === 'include') walk.includes.push([at, raw])
      out[key] = raw
    } else if (key === 'applyEndPatternLast') {
      if (typeof raw !== 'boolean' && raw !== 0 && raw !== 1) {
        walk.issues.push({ path: at, message: 'must be true or false.' })
        continue
      }
      out[key] = raw === true || raw === 1
    } else if (key === 'patterns') {
      if (!Array.isArray(raw)) {
        walk.issues.push({ path: at, message: 'must be an array of rules.' })
        continue
      }
      out[key] = raw.flatMap((rule, index) => cleanRule(rule, `${at}[${index}]`, depth + 1, walk) ?? [])
    } else if (key === 'repository' || key === 'injections') {
      if (!isRecord(raw)) {
        walk.issues.push({ path: at, message: 'must be an object of name to rule.' })
        continue
      }
      const repository: Record<string, unknown> = {}
      for (const [name, rule] of Object.entries(raw)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
          walk.issues.push({ path: `${at}.${name}`, message: 'is a reserved name.' })
          continue
        }
        if (key === 'repository') walk.repositoryNames.add(name)
        const cleaned = cleanRule(rule, `${at}.${name}`, depth + 1, walk)
        if (cleaned) repository[name] = cleaned
      }
      out[key] = repository
    } else if (CAPTURE_KEYS.has(key)) {
      if (!isRecord(raw)) {
        walk.issues.push({ path: at, message: 'must be an object of group number to rule.' })
        continue
      }
      const captures: Record<string, unknown> = {}
      for (const [group, rule] of Object.entries(raw)) {
        if (!/^\d{1,3}$/.test(group)) {
          walk.issues.push({ path: `${at}.${group}`, message: 'must be a capture group number.' })
          continue
        }
        const cleaned = cleanRule(rule, `${at}.${group}`, depth + 1, walk)
        if (cleaned) captures[group] = cleaned
      }
      out[key] = captures
    }
    // Any other key is not one the engine reads: dropped.
  }
  return out
}

/**
 * Check a parsed grammar against the scope its contribution declares. Every
 * `#name` it includes must name a repository rule; `$self` and `$base` are
 * its own; another scope it names resolves to nothing, so that region stays
 * plain.
 */
export function validateTextMateGrammar(value: unknown, scopeName: string): GrammarResult {
  if (!isRecord(value)) return { ok: false, issues: [{ path: '', message: 'must be a JSON object.' }] }
  if (value.scopeName !== scopeName)
    return {
      ok: false,
      issues: [{ path: 'scopeName', message: `must be "${scopeName}", the scope its extension.json declares.` }],
    }
  const walk: Walk = { issues: [], rules: 0, repositoryNames: new Set(), includes: [] }
  const grammar = cleanRule(value, '', 0, walk)
  if (grammar && !Array.isArray(grammar.patterns))
    walk.issues.push({ path: 'patterns', message: 'is required: the rules the grammar starts from.' })
  for (const [path, include] of walk.includes) {
    if (include.startsWith('#') && !walk.repositoryNames.has(include.slice(1)))
      walk.issues.push({ path, message: `names no repository rule: ${include}.` })
  }
  if (walk.issues.length === 0 && grammar) {
    const expanded = expandedRuleCount(grammar)
    if (expanded > MAX_EXPANDED_RULES)
      walk.issues.push({
        path: 'patterns',
        message: `expands, include by include, to more than ${MAX_EXPANDED_RULES} rules: an include that names rules which include each other over and over makes the highlighter's work grow without end.`,
      })
  }
  if (walk.issues.length > 0 || !grammar) return { ok: false, issues: walk.issues.map(stripLead) }
  return { ok: true, grammar: grammar as TextMateGrammar }
}

/** The most rules a grammar may expand to, following every include once per place it is named. */
export const MAX_EXPANDED_RULES = 10_000

/**
 * How many rules a grammar becomes once each `#name` include is replaced by
 * the rule it names, everywhere it is named: what the engine walks to find
 * where a line's next token starts. A grammar whose includes double at each
 * level (`a` includes `b` twice, `b` includes `c` twice, …) is a few hundred
 * bytes and expands to millions; counted with a memo per name it costs one
 * pass. A name met again inside its own expansion (a recursive grammar, which
 * is normal) counts once.
 */
function expandedRuleCount(grammar: Record<string, unknown>): number {
  const named = new Map<string, Array<Record<string, unknown>>>()
  const collect = (rule: unknown): void => {
    if (!isRecord(rule)) return
    for (const key of ['repository', 'injections']) {
      const repository = rule[key]
      if (!isRecord(repository)) continue
      for (const [name, child] of Object.entries(repository)) {
        if (key === 'repository' && isRecord(child)) named.set(name, [...(named.get(name) ?? []), child])
        collect(child)
      }
    }
    for (const child of Array.isArray(rule.patterns) ? rule.patterns : []) collect(child)
    for (const key of CAPTURE_KEYS)
      if (isRecord(rule[key])) for (const child of Object.values(rule[key])) collect(child)
  }
  collect(grammar)
  const memo = new Map<string, number>()
  const open = new Set<string>()
  const capped = (value: number) => Math.min(value, MAX_EXPANDED_RULES + 1)
  const sizeOfName = (name: string): number => {
    const known = memo.get(name)
    if (known !== undefined) return known
    if (open.has(name)) return 1
    open.add(name)
    const size = Math.max(1, ...(named.get(name) ?? []).map((rule) => sizeOf(rule)))
    open.delete(name)
    memo.set(name, size)
    return size
  }
  const sizeOf = (rule: Record<string, unknown>): number => {
    let size = 1
    const include = rule.include
    if (typeof include === 'string' && include.startsWith('#')) size += sizeOfName(include.slice(1))
    for (const child of Array.isArray(rule.patterns) ? rule.patterns : []) if (isRecord(child)) size += sizeOf(child)
    for (const key of CAPTURE_KEYS)
      if (isRecord(rule[key])) for (const child of Object.values(rule[key])) if (isRecord(child)) size += sizeOf(child)
    return capped(size)
  }
  return sizeOf(grammar)
}

function stripLead(issue: ManifestIssue): ManifestIssue {
  return { ...issue, path: issue.path.replace(/^\./, '') }
}

function parseJson(
  source: string,
  maxBytes: number,
): { ok: true; value: unknown } | { ok: false; issues: ManifestIssue[] } {
  if (source.length > maxBytes)
    return { ok: false, issues: [{ path: '', message: `is larger than ${Math.round(maxBytes / 1024)} KiB.` }] }
  try {
    return { ok: true, value: JSON.parse(source) as unknown }
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `is not JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
}

/** Parse and check a grammar file's text. */
export function parseTextMateGrammar(source: string, scopeName: string): GrammarResult {
  const parsed = parseJson(source, GRAMMAR_MAX_BYTES)
  return parsed.ok ? validateTextMateGrammar(parsed.value, scopeName) : parsed
}

// ── Language configuration ──────────────────────────────────────────────────

/** What a language configuration sets that Studio's editor reads. */
export type LanguageConfiguration = {
  comments?: { lineComment?: string; blockComment?: [string, string] }
  brackets?: Array<[string, string]>
  autoClosingPairs?: Array<{ open: string; close: string }>
  surroundingPairs?: Array<{ open: string; close: string }>
}

export type LanguageConfigurationResult =
  { ok: true; configuration: LanguageConfiguration } | { ok: false; issues: ManifestIssue[] }

const MAX_PAIRS = 64
// Printable text on one line: no control characters.
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f-\u009f]+$/u

function marker(value: unknown, path: string, max: number, issues: ManifestIssue[]): string | undefined {
  if (typeof value !== 'string' || !PRINTABLE_RE.test(value) || value.length > max) {
    issues.push({ path, message: `must be printable text on one line, at most ${max} characters.` })
    return undefined
  }
  return value
}

function pairs(
  value: unknown,
  path: string,
  max: number,
  issues: ManifestIssue[],
): Array<{ open: string; close: string }> | undefined {
  if (!Array.isArray(value) || value.length > MAX_PAIRS) {
    issues.push({ path, message: `must be an array of at most ${MAX_PAIRS} pairs.` })
    return undefined
  }
  const out: Array<{ open: string; close: string }> = []
  value.forEach((pair, index) => {
    const at = `${path}[${index}]`
    const [open, close] = Array.isArray(pair)
      ? [pair[0], pair[1]]
      : isRecord(pair)
        ? [pair.open, pair.close]
        : [undefined, undefined]
    const o = marker(open, `${at}.open`, max, issues)
    const c = marker(close, `${at}.close`, max, issues)
    if (o !== undefined && c !== undefined) out.push({ open: o, close: c })
  })
  return out
}

/**
 * Check a parsed language configuration. Comment markers and brackets may be
 * up to 128 characters; auto-closing and surrounding pairs up to 8, because
 * the editor types them as you type. Other keys are accepted and not read.
 */
export function validateLanguageConfiguration(value: unknown): LanguageConfigurationResult {
  if (!isRecord(value)) return { ok: false, issues: [{ path: '', message: 'must be a JSON object.' }] }
  const issues: ManifestIssue[] = []
  const configuration: LanguageConfiguration = {}
  if (value.comments !== undefined) {
    if (!isRecord(value.comments)) issues.push({ path: 'comments', message: 'must be an object.' })
    else {
      const comments: NonNullable<LanguageConfiguration['comments']> = {}
      if (value.comments.lineComment !== undefined) {
        const line = marker(value.comments.lineComment, 'comments.lineComment', 128, issues)
        if (line) comments.lineComment = line
      }
      if (value.comments.blockComment !== undefined) {
        const block = value.comments.blockComment
        if (!Array.isArray(block) || block.length !== 2)
          issues.push({ path: 'comments.blockComment', message: 'must be [open, close].' })
        else {
          const open = marker(block[0], 'comments.blockComment[0]', 128, issues)
          const close = marker(block[1], 'comments.blockComment[1]', 128, issues)
          if (open && close) comments.blockComment = [open, close]
        }
      }
      configuration.comments = comments
    }
  }
  if (value.brackets !== undefined) {
    const brackets = pairs(value.brackets, 'brackets', 128, issues)
    if (brackets) configuration.brackets = brackets.map(({ open, close }) => [open, close])
  }
  if (value.autoClosingPairs !== undefined) {
    const found = pairs(value.autoClosingPairs, 'autoClosingPairs', 8, issues)
    if (found) configuration.autoClosingPairs = found
  }
  if (value.surroundingPairs !== undefined) {
    const found = pairs(value.surroundingPairs, 'surroundingPairs', 8, issues)
    if (found) configuration.surroundingPairs = found
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, configuration }
}

/** Parse and check a language configuration file's text. */
export function parseLanguageConfiguration(source: string): LanguageConfigurationResult {
  const parsed = parseJson(source, LANGUAGE_CONFIGURATION_MAX_BYTES)
  return parsed.ok ? validateLanguageConfiguration(parsed.value) : parsed
}
