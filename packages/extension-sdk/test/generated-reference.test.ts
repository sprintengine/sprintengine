// The two files generated from extension.json's field table: the JSON Schema
// the package ships (extension.schema.json) and the reference table in
// guide/manifest.md. Each must match what the table produces now, so the
// validator, the schema and the guide cannot disagree.
//
// Run with UPDATE_EXTENSION_REFERENCE=1 to rewrite both.

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { extensionHookReference } from '../src/hooks.js'
import {
  EXTENSION_MANIFEST_SINCE,
  extensionManifestJsonSchema,
  extensionManifestReference,
  validateExtensionManifest,
} from '../src/extension-manifest.js'

const SDK = join(process.cwd(), 'packages/extension-sdk')
const SCHEMA_PATH = join(SDK, 'extension.schema.json')
const GUIDE_PATH = join(SDK, 'guide/manifest.md')
const START = '<!-- generated:extension-manifest-reference:start -->'
const END = '<!-- generated:extension-manifest-reference:end -->'
const UPDATE = process.env.UPDATE_EXTENSION_REFERENCE === '1'
const HOW =
  'Run `UPDATE_EXTENSION_REFERENCE=1 npx vitest run packages/extension-sdk/test/generated-reference.test.ts` to rewrite it.'

test('extension.schema.json is the schema the field table produces', () => {
  const expected = `${JSON.stringify(extensionManifestJsonSchema(), null, 2)}\n`
  if (UPDATE) writeFileSync(SCHEMA_PATH, expected)
  assert.ok(readFileSync(SCHEMA_PATH, 'utf8') === expected, `extension.schema.json is out of date. ${HOW}`)
})

test('guide/manifest.md carries the reference the field table produces', () => {
  const guide = readFileSync(GUIDE_PATH, 'utf8')
  const start = guide.indexOf(START)
  const end = guide.indexOf(END)
  assert.ok(start !== -1 && end > start, `guide/manifest.md must hold ${START} … ${END}.`)
  const expected = `${guide.slice(0, start + START.length)}\n\n${extensionManifestReference()}\n\n${guide.slice(end)}`
  if (UPDATE) writeFileSync(GUIDE_PATH, expected)
  assert.ok(
    readFileSync(GUIDE_PATH, 'utf8') === expected,
    `The generated reference in guide/manifest.md is out of date. ${HOW}`,
  )
})

test('guide/hooks.md carries the table of points the hook table produces', () => {
  const path = join(SDK, 'guide/hooks.md')
  const open = '<!-- generated:extension-hook-reference:start -->'
  const close = '<!-- generated:extension-hook-reference:end -->'
  const guide = readFileSync(path, 'utf8')
  const start = guide.indexOf(open)
  const end = guide.indexOf(close)
  assert.ok(start !== -1 && end > start, `guide/hooks.md must hold ${open} … ${close}.`)
  const expected = `${guide.slice(0, start + open.length)}\n\n${extensionHookReference()}\n\n${guide.slice(end)}`
  if (UPDATE) writeFileSync(path, expected)
  assert.ok(readFileSync(path, 'utf8') === expected, `The generated table in guide/hooks.md is out of date. ${HOW}`)
})

test('the schema says what a pattern can of paths, and that the worker tier needs main', () => {
  const schema = extensionManifestJsonSchema() as {
    properties: Record<string, { pattern?: string; properties?: Record<string, unknown> }>
    allOf: unknown[]
  }
  const main = new RegExp(schema.properties.main!.pattern!, 'u')
  for (const path of ['dist/main.cjs', 'main.mjs']) expect(main.test(path), path).toBe(true)
  for (const path of [
    '../main.cjs',
    '/main.cjs',
    'dist/../main.cjs',
    'dist//main.cjs',
    'C:/main.cjs',
    'dist\\main.cjs',
  ]) {
    expect(main.test(path), path).toBe(false)
  }
  expect(JSON.stringify(schema.allOf)).toBe(
    '[{"if":{"properties":{"tier":{"const":"worker"}},"required":["tier"]},"then":{"required":["main"]}}]',
  )
})

test('the schema and the validator agree on a path’s suffix, whatever its case', () => {
  const schema = extensionManifestJsonSchema() as { properties: Record<string, { pattern?: string }> }
  const cover = new RegExp(schema.properties.cover!.pattern!, 'u')
  const main = new RegExp(schema.properties.main!.pattern!, 'u')
  const base = {
    manifestVersion: 1,
    id: 'demo',
    version: '1.0.0',
    engines: { studio: `>=${EXTENSION_MANIFEST_SINCE}` },
    tier: 'worker',
    name: 'Demo',
    main: 'dist/main.cjs',
  }
  for (const path of ['images/cover.png', 'images/cover.PNG', 'images/cover.Jpeg', 'images/cover.gif']) {
    expect(cover.test(path), path).toBe(validateExtensionManifest({ ...base, cover: path }).ok)
  }
  for (const path of ['dist/main.CJS', 'dist/Main.Mjs', 'dist/main.ts']) {
    expect(main.test(path), path).toBe(validateExtensionManifest({ ...base, main: path }).ok)
  }
})
