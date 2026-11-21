// The Settings section, rendered against the SDK's fake renderer host.
// `npm test` bundles test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Settings } from '../src/settings'
import { manifest } from './manifest'

test('the section shows what was saved', async () => {
  const renderer = createFakeRendererHost({ manifest, appState: { label: 'Night shift' } })
  const studio = renderer.studio({ point: 'settingsSections', id: 'settings' })
  assert.match(await renderToHtml(createElement(Settings, { studio })), /Night shift/)
  assert.deepEqual(renderer.undeclared, [])
})
