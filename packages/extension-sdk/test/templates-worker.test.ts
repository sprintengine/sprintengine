import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

// What the templates' workers are declared as, now that a worker runs as
// plain Node in a process of its own, from source, and is stopped when idle.

const TEMPLATES = join(process.cwd(), 'packages/extension-sdk/templates')

test('a template that keeps listening across idle periods runs in the background', () => {
  const manifest = JSON.parse(readFileSync(join(TEMPLATES, 'chat-companion/extension/extension.json'), 'utf8')) as {
    background?: boolean
  }
  // It watches its chats from onStartup: an on-demand worker would be stopped, and its watch with it.
  assert.equal(manifest.background, true)
})

test('every template worker is its source, which Studio loads in Node as written', () => {
  const workers = readdirSync(TEMPLATES, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('_')) return []
    const manifest = JSON.parse(readFileSync(join(TEMPLATES, entry.name, 'extension/extension.json'), 'utf8')) as {
      main?: string
    }
    return manifest.main ? [{ template: entry.name, main: manifest.main }] : []
  })
  assert.ok(workers.length > 0)
  for (const { template, main } of workers) {
    assert.equal(main, 'src/main.ts', `${template}: main is the worker's source`)
    // Node strips its types: an enum or a namespace needs code, and fails to load.
    const source = readFileSync(join(TEMPLATES, template, 'extension', main), 'utf8')
    assert.ok(
      !/^\s*(?:export\s+)?(?:const\s+)?(?:enum|namespace)\s/m.test(source),
      `${template}: only erasable TypeScript`,
    )
  }
})
