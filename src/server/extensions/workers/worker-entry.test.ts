import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { test } from 'vitest'

// The worker entry is bundled on its own (electron.vite.config.ts, beside
// main; scripts/build-server.mjs, beside the server) and runs from outside the
// app archive. A value it imported from the app would put a chunk it shares
// with main inside the archive, where its process could not load it. The one
// exception is the SDK's TypeScript loader (source-hooks.ts), which imports
// only Node's own modules and which nothing else Studio bundles imports, so
// it is inlined into the entry and shares no chunk.

const runtimeImports = (source: string) =>
  [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gmsu)]
    .filter(([, typeOnly]) => typeOnly === undefined)
    .map(([, , specifier]) => specifier!)

const SOURCE_HOOKS = '../../../../packages/extension-sdk/src/source-hooks'

test('the worker entry imports nothing at run time but Node’s own modules and the SDK’s TypeScript loader', () => {
  const imports = runtimeImports(readFileSync(join(__dirname, 'worker-entry.ts'), 'utf8'))
  assert.ok(imports.length > 0)
  for (const specifier of imports)
    assert.ok(
      specifier.startsWith('node:') || specifier === SOURCE_HOOKS,
      `worker-entry.ts imports ${specifier} at run time`,
    )
  const hooks = runtimeImports(readFileSync(join(__dirname, `${SOURCE_HOOKS}.ts`), 'utf8'))
  for (const specifier of hooks)
    assert.ok(specifier.startsWith('node:'), `source-hooks.ts imports ${specifier} at run time`)
})

test('nothing else Studio bundles imports the TypeScript loader, so it shares no chunk with main', () => {
  const root = join(__dirname, '../../..')
  const importers: string[] = []
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) visit(path)
      else if (
        /\.tsx?$/u.test(name) &&
        !/\.test\.tsx?$/u.test(name) &&
        /from '[^']*source-hooks'/u.test(readFileSync(path, 'utf8'))
      )
        importers.push(relative(root, path))
    }
  }
  visit(root)
  assert.deepEqual(importers, ['server/extensions/workers/worker-entry.ts'])
})
