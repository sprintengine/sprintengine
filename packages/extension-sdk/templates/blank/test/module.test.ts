// Your tests, in TypeScript. `npm test` bundles test/*.test.ts with esbuild
// (`npm run build:test`, into test/.build) and runs them with `node --test`.
// Import the source directly and drive it with the SDK's fake hosts; hand them
// `manifest` from ./manifest, the validated extension.json.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Hello } from '../src/hello'
import { manifest } from './manifest'

test('the panel says hello, and says which extension it is', async () => {
  const renderer = createFakeRendererHost({ manifest })
  const studio = renderer.studio({ point: 'panels', id: 'hello', workspaceId: 'ws-app' })
  const html = await renderToHtml(createElement(Hello, { studio }))
  assert.match(html, /Hello from/)
  assert.ok(html.includes(`local.${manifest.id}`), html)
  assert.deepEqual(renderer.undeclared, [], 'everything it used is declared in extension/extension.json')
})
