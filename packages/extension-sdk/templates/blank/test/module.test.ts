// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Import the source and
// drive it with the SDK's fakes; hand them `manifest` from ./manifest, the
// validated extension.json. A test has no DOM: what the panel draws is in the
// shots `npm run dev` writes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { greeting } from '../extension/src/hello'
import { manifest } from './manifest'

test('the panel says hello, and says which panel it is', () => {
  const frame = createFakeFrameStudio({ manifest })
  const studio = frame.studio({ point: 'panels', id: 'hello', workspaceId: 'ws-app' })
  const { heading, detail } = greeting(studio)
  assert.match(heading, /Hello from/)
  assert.match(detail, /the hello panel/)
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})
