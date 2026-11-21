import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

// The worker entry is bundled on its own (electron.vite.config.ts, beside
// main; scripts/build-server.mjs, beside the server) and runs from outside the
// app archive. A value it imported from the app would put a chunk it shares
// with main inside the archive, where its process could not load it.
test('the worker entry imports nothing at run time but Node’s own modules', () => {
  const source = readFileSync(join(__dirname, 'worker-entry.ts'), 'utf8')
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gmsu)]
  assert.ok(imports.length > 0)
  for (const [, typeOnly, specifier] of imports) {
    assert.ok(
      typeOnly !== undefined || specifier!.startsWith('node:'),
      `worker-entry.ts imports ${specifier} at run time`,
    )
  }
})
