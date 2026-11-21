// The door, rendered against the SDK's fake renderer host. `npm test` bundles
// test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Door } from '../src/door'
import { manifest } from './manifest'

test('the door renders', async () => {
  const renderer = createFakeRendererHost({ manifest })
  const studio = renderer.studio({ point: 'doors', id: 'door' })
  assert.match(await renderToHtml(createElement(Door, { studio })), /Nothing here yet/)
  assert.deepEqual(renderer.undeclared, [])
})
