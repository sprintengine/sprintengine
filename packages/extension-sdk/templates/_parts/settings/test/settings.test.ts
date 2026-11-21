// The Settings section, rendered against the SDK's fake frame studio.
// `npm test` bundles test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeFrameStudio, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { Settings } from '../src/settings'
import { manifest } from './manifest'

test('the section shows what was saved', async () => {
  const frame = createFakeFrameStudio({ manifest, settings: { label: 'Night shift' } })
  const studio = frame.studio({ point: 'settingsSections', id: 'settings' })
  const saved = await studio.host.call('settings.get', {})
  assert.match(await renderToHtml(createElement(Settings, { studio, initial: String(saved.label) })), /Night shift/)
  assert.deepEqual(frame.undeclared, [])
})
