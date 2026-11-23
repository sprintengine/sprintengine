import assert from 'node:assert/strict'

import { test } from 'vitest'

import { surfaceHostCallIssues, workerHostCallIssues } from '../src/host-calls.js'

// Only calls written as code are checked: the same text inside a string, a
// template's text or a comment is not a call.

const manifest = { permissions: [], main: 'src/main.ts' }

test('a call-like text inside a string, a template or a comment is not a call', () => {
  const source = [
    `const help = "studio.host.call('nope.method') is how a frame asks"`,
    `const shown = 'studio.host.call("also.nope")'`,
    "const doc = `use studio.host.call('still.nope') to ask`",
    `// studio.host.call('commented.nope')`,
    `/* studio.host.call('blocked.nope') */`,
    `const usage = "studio.document is for editors"`,
  ].join('\n')
  assert.deepEqual(surfaceHostCallIssues('src/panel.ts', source, 'panels', manifest), [])
  assert.deepEqual(workerHostCallIssues('src/main.ts', `const text = "studio.listChatRuntimes()"\n`, manifest), [])
  assert.equal(
    workerHostCallIssues('src/main.ts', `void studio.listChatRuntimes()\n`, manifest).length,
    1,
    'the real call needs providers:read',
  )
})

test('a real call is still found, at its line and column, inside a template expression too', () => {
  const source = [
    `const a = "a string first"`,
    `void studio.host.call('nope.method', {})`,
    'const b = `${await studio.host.call("other.nope")} done`',
  ].join('\n')
  const issues = surfaceHostCallIssues('src/panel.ts', source, 'panels', manifest)
  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.column, issue.message]),
    [
      [2, 6, 'studio.host.call("nope.method") names no host method Studio offers.'],
      [3, 20, 'studio.host.call("other.nope") names no host method Studio offers.'],
    ],
  )
})
