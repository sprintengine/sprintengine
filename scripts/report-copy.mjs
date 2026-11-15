#!/usr/bin/env node
// Every word the app shows, in one list, longest first, so it can be read and
// cut in one sitting (owner ruling 2026-11-15). Two parts:
//
//   1. The catalog, src/shared/copy/en.ts: where the words are meant to live.
//   2. What is still written inline: tooltips, accessible names, titles,
//      placeholders, descriptions and JSX text in the clients' source. Each
//      one moved into the catalog leaves this list.
//
// A tooltip past about 50 characters is an article (design-system tooltip
// spec), so anything longer is marked.
//
// Usage:
//   npm run report:copy                      # markdown to stdout
//   npm run report:copy -- --out copy.md     # to a file
//   npm run report:copy -- --min 50          # only the long ones
//   npm run report:copy -- --json

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { parseSync } from 'oxc-parser'

const repoRoot = resolve(import.meta.dirname, '..')
const CATALOG = 'src/shared/copy/en.ts'
const ROOTS = ['src/renderer/src', 'mobile/src', 'mobile/App.tsx']
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'out', '__fixtures__', '__mocks__'])
const LONG = 50

// Attribute and property names whose value is shown to a person.
const COPY_KEYS = new Set([
  'title',
  'aria-label',
  'aria-description',
  'tooltip',
  'label',
  'placeholder',
  'description',
  'content',
  'hint',
  'message',
  'body',
  'detail',
  'caption',
  'subtitle',
  'heading',
  'alt',
])
const COPY_SUFFIX = /(Label|Title|Description|Hint|Tooltip|Placeholder|Message|Caption|Text)$/

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? null : process.argv[i + 1]
}

function isCopyKey(name) {
  return COPY_KEYS.has(name) || COPY_SUFFIX.test(name)
}

function walkFiles(path) {
  const abs = join(repoRoot, path)
  let entries
  try {
    entries = readdirSync(abs, { withFileTypes: true })
  } catch {
    return [path]
  }
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...walkFiles(join(path, entry.name)))
    } else if (['.ts', '.tsx'].includes(extname(entry.name)) && !/\.(test|spec|stories)\.tsx?$/.test(entry.name)) {
      out.push(join(path, entry.name))
    }
  }
  return out
}

function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

// A template literal as it reads, with each `${…}` kept as written.
function templateText(node, source) {
  return source.slice(node.start + 1, node.end - 1)
}

// The literal strings a value can evaluate to: both arms of a conditional,
// either side of `??` / `||`, and the value itself.
function literals(node, source) {
  if (!node) return []
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [{ text: node.value, start: node.start }] : []
    case 'TemplateLiteral':
      return [{ text: templateText(node, source), start: node.start }]
    case 'JSXExpressionContainer':
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
      return literals(node.expression, source)
    case 'ConditionalExpression':
      return [...literals(node.consequent, source), ...literals(node.alternate, source)]
    case 'LogicalExpression':
      return [...literals(node.left, source), ...literals(node.right, source)]
    default:
      return []
  }
}

// Words, not identifiers, class lists, paths or keys.
function looksLikeCopy(text) {
  const t = text.trim()
  if (!/[A-Za-z]{2}/.test(t)) return false
  if (/^[a-z][\w.:/-]*$/.test(t) && !t.includes(' ')) return false
  if (/^[\w-]+(\s+[\w:[\]/.-]+)+$/.test(t) && /\b(flex|px-|py-|text-|bg-|rounded|w-|h-)/.test(t)) return false
  return true
}

function visit(node, fn) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) visit(child, fn)
    return
  }
  if (typeof node.type === 'string') fn(node)
  for (const key in node) {
    if (key === 'parent') continue
    const value = node[key]
    if (value && typeof value === 'object') visit(value, fn)
  }
}

function inlineCopy(file) {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  const { program } = parseSync(file, source)
  const found = []
  const add = (kind, hit) => {
    const text = hit.text.replace(/\s+/g, ' ').trim()
    if (looksLikeCopy(text)) found.push({ file, line: lineOf(source, hit.start), kind, text })
  }
  visit(program, (node) => {
    if (node.type === 'JSXAttribute' && node.name?.type === 'JSXIdentifier' && isCopyKey(node.name.name)) {
      for (const hit of literals(node.value, source)) add(node.name.name, hit)
    } else if (node.type === 'JSXText') {
      add('text', { text: node.value, start: node.start })
    } else if (node.type === 'Property' && !node.computed) {
      const key = node.key?.type === 'Identifier' ? node.key.name : node.key?.value
      if (typeof key === 'string' && isCopyKey(key)) {
        for (const hit of literals(node.value, source)) add(key, hit)
      }
    }
  })
  return found
}

function catalogCopy() {
  const source = readFileSync(join(repoRoot, CATALOG), 'utf8')
  const { program } = parseSync(CATALOG, source)
  const out = []
  const walk = (object, path) => {
    for (const prop of object.properties) {
      if (prop.type !== 'Property') continue
      const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value)
      const here = [...path, key]
      const value = prop.value
      if (value.type === 'ObjectExpression') {
        walk(value, here)
      } else if (value.type === 'ArrowFunctionExpression') {
        for (const hit of literals(value.body, source))
          out.push({ key: here.join('.'), line: lineOf(source, hit.start), text: hit.text })
      } else {
        for (const hit of literals(value, source))
          out.push({ key: here.join('.'), line: lineOf(source, hit.start), text: hit.text })
      }
    }
  }
  visit(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.name === 'en' && node.init?.type === 'ObjectExpression') {
      walk(node.init, [])
    }
  })
  return out
}

function cell(text) {
  return text.replace(/\|/g, '\\|')
}

function main() {
  const min = Number.parseInt(argValue('--min') ?? '0', 10) || 0
  const catalog = catalogCopy().sort((a, b) => b.text.length - a.text.length)
  const inline = ROOTS.flatMap(walkFiles)
    .flatMap(inlineCopy)
    .sort((a, b) => b.text.length - a.text.length)
  const keep = (entry) => entry.text.length >= min

  if (process.argv.includes('--json')) {
    const json = JSON.stringify({ catalog: catalog.filter(keep), inline: inline.filter(keep) }, null, 2)
    emit(json + '\n')
    return
  }

  const long = (entry) => (entry.text.length > LONG ? ' ⚠' : '')
  const lines = [
    '# The app’s words',
    '',
    `${catalog.length} in the catalog (${CATALOG}), ${inline.length} still inline. ` +
      `⚠ marks anything over ${LONG} characters.`,
    '',
    '## Catalog',
    '',
    '| Chars | Key | Text |',
    '| ---: | --- | --- |',
    ...catalog.filter(keep).map((e) => `| ${e.text.length}${long(e)} | \`${e.key}\` | ${cell(e.text)} |`),
    '',
    '## Still inline',
    '',
    '| Chars | Where | Kind | Text |',
    '| ---: | --- | --- | --- |',
    ...inline
      .filter(keep)
      .map((e) => `| ${e.text.length}${long(e)} | ${e.file}:${e.line} | ${e.kind} | ${cell(e.text)} |`),
    '',
  ]
  emit(lines.join('\n'))
}

function emit(text) {
  const out = argValue('--out')
  if (out) {
    writeFileSync(resolve(out), text)
    console.log(`wrote ${relative(process.cwd(), resolve(out)) || out}`)
  } else {
    process.stdout.write(text)
  }
}

main()
