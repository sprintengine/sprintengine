// The Settings section's calls, against the SDK's fake frame studio.
// `npm test` runs test/*.test.ts with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { loadLabel, saveLabel } from '../extension/src/settings'
import { manifest } from './manifest'

const surface = { point: 'settingsSections', id: 'settings' } as const

test('the section shows what was saved', async () => {
  const frame = createFakeFrameStudio({ manifest, settings: { label: 'Night shift' } })
  assert.equal(await loadLabel(frame.studio(surface)), 'Night shift')
  assert.deepEqual(frame.undeclared, [])
})

test('what the section saves Studio keeps', async () => {
  const frame = createFakeFrameStudio({ manifest })
  await saveLabel(frame.studio(surface), 'Day shift')
  assert.deepEqual(frame.settings(), { label: 'Day shift' })
})
