// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest. A test has no DOM:
// it calls what the panel asks Studio for, and the drawing is in the shots
// `npm run dev` writes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { loadNotes, saveNotes } from '../extension/src/notes'
import { manifest } from './manifest'

const surface = { point: 'panels', id: 'notes', workspaceId: 'ws-app' } as const

test('the panel shows what was saved', async () => {
  const frame = createFakeFrameStudio({ manifest, settings: { notes: 'Buy milk' } })
  assert.equal(await loadNotes(frame.studio(surface)), 'Buy milk')
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('with nothing saved, the panel starts empty', async () => {
  const frame = createFakeFrameStudio({ manifest })
  assert.equal(await loadNotes(frame.studio(surface)), '')
})

test('what the panel saves Studio keeps', async () => {
  const frame = createFakeFrameStudio({ manifest })
  await saveNotes(frame.studio(surface), 'Call the plumber')
  assert.deepEqual(frame.settings(), { notes: 'Call the plumber' })
  assert.deepEqual(frame.undeclared, [])
})
