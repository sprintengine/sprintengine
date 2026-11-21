// The door, rendered against the SDK's fake frame studio. `npm test` bundles
// test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeFrameStudio, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Door } from '../src/door'
import { manifest } from './manifest'

test('the door renders', async () => {
  const frame = createFakeFrameStudio({ manifest })
  const studio = frame.studio({ point: 'doors', id: 'door' })
  assert.match(await renderToHtml(createElement(Door, { studio })), /Nothing here yet/)
  assert.deepEqual(frame.undeclared, [])
})
