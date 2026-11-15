import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'vitest'

// The renderer is one client of the Studio server, and the server, the shell
// and the code they share must not depend on it, not even for a type. A type
// import is erased from the bundle, so electron-boundary.test.ts (which walks
// the bundler's graph) cannot see it; but it still makes a client folder the
// owner of the contract, and the next import from that folder is copied from
// it. This reads the source, so a type-only import counts.
//
// Tests are left out: an end-to-end test drives a client against a server on
// purpose.

const ROOT = join(__dirname, '..', '..')
const RENDERER = join(ROOT, 'src', 'renderer') + sep

const NOT_RENDERER: readonly string[] = ['src/main', 'src/server', 'src/preload', 'src/shared']

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') files.push(...sourceFilesUnder(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|test-helper)\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

/** Source text with comments blanked, so prose that quotes an import is not one. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

// `from '…'`, `import '…'`, `import('…')` (also inside `typeof import('…')`)
// and `require('…')`.
const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g

/** Each `file:line: specifier` in `source` that loads something under src/renderer/. */
function rendererImports(file: string, source: string): string[] {
  const found: string[] = []
  withoutComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        const target = specifier.startsWith('.')
          ? resolve(ROOT, dirname(file), specifier)
          : specifier.startsWith('@renderer/')
            ? join(RENDERER, 'src', specifier.slice('@renderer/'.length))
            : null
        if (target?.startsWith(RENDERER)) found.push(`${file}:${index + 1}: ${specifier}`)
      }
    })
  return found
}

test('no server, shell or shared file imports from the renderer, not even a type', () => {
  const found = NOT_RENDERER.flatMap(sourceFilesUnder).flatMap((file) =>
    rendererImports(file, readFileSync(join(ROOT, file), 'utf8')),
  )
  assert.deepEqual(
    found,
    [],
    'A type both sides use belongs in src/shared/ (or a protocol package), not in the renderer:\n  ' +
      found.join('\n  '),
  )
})

test('the scan finds a renderer import in each form it refuses', () => {
  // So the guard above cannot pass because the scan saw nothing.
  const file = 'src/shared/example.ts'
  const source = [
    "import type { Workspace } from '../renderer/src/types/workspace'",
    "import { useStore } from '@renderer/store/workspaceStore'",
    "type Api = typeof import('../renderer/src/studio/files')",
    "import '../renderer/src/main.css'",
    "const lazy = require('../renderer/src/utils/diagnostics')",
    "// import type { Workspace } from '../renderer/src/types/workspace'",
    "import type { AgentState } from './agent-state'",
  ].join('\n')
  assert.deepEqual(
    rendererImports(file, source).map((entry) => entry.split(': ')[0]),
    [1, 2, 3, 4, 5].map((line) => `${file}:${line}`),
  )
})
