// Your tests, in TypeScript. `npm test` bundles test/*.test.ts with esbuild
// (`npm run build:test`, into test/.build) and runs them with `node --test`.
// Import the source directly and drive it with the SDK's fakes; hand them
// `manifest` from ./manifest, the validated extension.json.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeFrameStudio, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Hello } from '../src/hello'
import { manifest } from './manifest'

test('the panel says hello, and says which panel it is', async () => {
  const frame = createFakeFrameStudio({ manifest })
  const studio = frame.studio({ point: 'panels', id: 'hello', workspaceId: 'ws-app' })
  const html = await renderToHtml(createElement(Hello, { studio }))
  assert.match(html, /Hello from/)
  assert.match(html, /the hello panel/)
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})
