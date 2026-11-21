// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes,
// handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeFrameStudio, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { NotesPanel } from '../src/notes'
import { manifest } from './manifest'

const surface = { point: 'panels', id: 'notes', workspaceId: 'ws-app' } as const

test('the panel shows what was saved', async () => {
  const frame = createFakeFrameStudio({ manifest, settings: { notes: 'Buy milk' } })
  const studio = frame.studio(surface)
  const saved = await studio.host.call('settings.get', {})
  const html = await renderToHtml(createElement(NotesPanel, { studio, initial: String(saved.notes) }))
  assert.match(html, /Buy milk/)
  assert.match(html, /Saved/)
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('what the panel saves Studio keeps', async () => {
  const frame = createFakeFrameStudio({ manifest })
  await frame.studio(surface).host.call('settings.set', { key: 'notes', value: 'Call the plumber' })
  assert.deepEqual(frame.settings(), { notes: 'Call the plumber' })
})
