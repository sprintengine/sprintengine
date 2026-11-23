import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildSurfaceModules,
  formatSourceProblem,
  moduleCandidatePaths,
  transpileExtensionSource,
} from '../src/source-modules.js'

// A surface loads as written: its TypeScript and JSX transpiled with every
// line kept, its relative imports gathered into its frame, and anything that
// cannot load said at its file and line.

const files =
  (map: Record<string, string>) =>
  (path: string): string | null =>
    map[path] ?? null

test('types and JSX go, and every line stays where it was', () => {
  const code = transpileExtensionSource(
    'src/panel.tsx',
    'const count: number = 1\ntype X = string\nexport const view = <b>{count}</b>\n',
  )
  assert.equal(code.split('\n').length, 4)
  assert.match(code.split('\n')[2]!, /h\('b', null, count\)/)
  assert.doesNotMatch(code, /: number/)
})

test('an import is found as TypeScript writes it: no extension, .js for .ts, a folder’s index', () => {
  assert.deepEqual(moduleCandidatePaths('src/util.js').slice(0, 3), ['src/util.js', 'src/util.ts', 'src/util.tsx'])
  assert.ok(moduleCandidatePaths('src/list').includes('src/list.ts'))
  assert.ok(moduleCandidatePaths('src/list').includes('src/list/index.ts'))
})

test('the entry loads last, after what it imports, each import its module’s token', () => {
  const graph = buildSurfaceModules(
    'src/panel.ts',
    files({
      'src/panel.ts':
        "import { label } from './label.js'\nimport { h } from './dom'\nexport function mount() { return h(label) }\n",
      'src/label.ts': "import { h } from './dom'\nexport const label: string = h('x')\n",
      'src/dom.ts': 'export function h(value: string) { return value }\n',
    }),
  )
  assert.ok(graph.ok)
  assert.deepEqual(
    graph.modules.map((module) => module.path),
    ['src/dom.ts', 'src/label.ts', 'src/panel.ts'],
  )
  assert.match(graph.modules[2]!.code, new RegExp(`from '${graph.token}1'`))
  assert.match(graph.modules[2]!.code, new RegExp(`from '${graph.token}0'`))
  assert.match(graph.token, /^se-module-[0-9a-f]{16}-$/u)
})

test('the same sources build the same document', () => {
  const read = files({ 'src/a.ts': 'export const mount = () => 1\n' })
  const first = buildSurfaceModules('src/a.ts', read)
  const second = buildSurfaceModules('src/a.ts', read)
  assert.deepEqual(first, second)
})

test('what cannot load is said at its file and line', () => {
  const bare = buildSurfaceModules('src/a.ts', files({ 'src/a.ts': "\nimport 'react'\nexport const mount = 1\n" }))
  assert.ok(!bare.ok)
  assert.equal(bare.problem.file, 'src/a.ts')
  assert.equal(bare.problem.line, 2)
  assert.match(bare.problem.message, /without a bundler/)

  const missing = buildSurfaceModules('src/a.ts', files({ 'src/a.ts': "import { x } from './gone'\nexport { x }\n" }))
  assert.ok(!missing.ok)
  assert.match(formatSourceProblem(missing.problem), /^src\/a\.ts:1:\d+ cannot import "\.\/gone"/u)

  const outside = buildSurfaceModules('src/a.ts', files({ 'src/a.ts': "import '../../secret'\n" }))
  assert.ok(!outside.ok)
  assert.match(outside.problem.message, /outside the extension/)

  const syntax = buildSurfaceModules(
    'src/a.ts',
    files({ 'src/a.ts': 'export function mount(root: HTMLElement {\n}\n' }),
  )
  assert.ok(!syntax.ok)
  assert.equal(syntax.problem.file, 'src/a.ts')
  assert.equal(syntax.problem.line, 1)

  const cycle = buildSurfaceModules(
    'src/a.ts',
    files({ 'src/a.ts': "import './b'\nexport const mount = 1\n", 'src/b.ts': "import './a'\n" }),
  )
  assert.ok(!cycle.ok)
  assert.match(cycle.problem.message, /cycles cannot load/)
})
