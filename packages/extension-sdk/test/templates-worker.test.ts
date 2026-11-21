import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

// What the templates' workers are built and declared as, now that a worker
// runs as plain Node in a process of its own and is stopped when idle.

const TEMPLATES = join(process.cwd(), 'packages/extension-sdk/templates')

test('a template that keeps listening across idle periods runs in the background', () => {
  const manifest = JSON.parse(readFileSync(join(TEMPLATES, 'chat-companion/extension/extension.json'), 'utf8')) as {
    background?: boolean
  }
  // It watches its chats from onStartup: an on-demand worker would be stopped, and its watch with it.
  assert.equal(manifest.background, true)
})

test('no template leaves electron out of its worker bundle', () => {
  const files = readdirSync(TEMPLATES, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return []
    if (entry.name === '_parts')
      return readdirSync(join(TEMPLATES, '_parts'), { withFileTypes: true })
        .filter((part) => part.isDirectory())
        .map((part) => join(TEMPLATES, '_parts', part.name, 'part.json'))
    return [join(TEMPLATES, entry.name, 'package.json')]
  })
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    assert.ok(!text.includes('--external:electron'), `${file} still leaves electron external`)
  }
})
