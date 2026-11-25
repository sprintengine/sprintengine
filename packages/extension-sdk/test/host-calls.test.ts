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

test('a components panel’s file is read for the host it imports: host.call, and worker without a worker', () => {
  const source = [
    `import { host, worker } from '@sprintengine/extension-sdk/components'`,
    `void host.call('files.read', { workspaceId: 'w', path: 'a' })`,
    `void worker.read('cards.list')`,
    `void myhost.call('not.ours')`,
  ].join('\n')
  const issues = surfaceHostCallIssues('src/panel.tsx', source, 'panels', { permissions: [] }, { components: true })
  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.message]),
    [
      [3, "worker.read and worker.operate reach the extension's worker, and it has none (worker tier)."],
      [
        2,
        'host.call("files.read") needs the "workspace-files:read" permission, which extension.json does not ask for.',
      ],
    ],
  )
  // A frame's file is read as before: a bare `host.call` is not its `studio.host.call`.
  assert.deepEqual(surfaceHostCallIssues('src/panel.ts', source, 'panels', manifest), [])
})
