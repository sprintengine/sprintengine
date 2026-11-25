// Your tests: `npm test` runs test/*.test.ts and .tsx with `node --test`,
// loading the source as Studio loads it, the panel's JSX compiled for the
// components module (see AGENTS.md). `mountPanel` boots the panel as Studio
// does, against the SDK's fake Studio (hand it `manifest` from ./manifest),
// and acts on it as the person would: `type`, `press`, `toggle`, … Read back
// what Studio would draw (`find`, `valueOf`, `tree()`), what it would store
// (`persisted`), and what went wrong (`errors`, `warnings`, `refusals`).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mountPanel } from '@sprintengine/extension-sdk/testing'

import * as panel from '../extension/src/panel'
import { manifest } from './manifest'

const options = { manifest, panelId: 'checklist' }

test('an item typed and added is on the list, and kept for the workspace', async () => {
  const view = await mountPanel(panel, options)
  assert.ok(view.find({ type: 'EmptyState' }), 'an empty list says so')

  await view.type({ label: 'New item' }, 'Water the plants', { submit: true })
  assert.ok(view.find({ role: 'checkbox', label: 'Water the plants' }))
  assert.equal(view.valueOf({ label: 'New item' }), '', 'the box is cleared for the next one')
  const stored = view.persisted.workspace.items as panel.Item[]
  assert.deepEqual(
    stored.map((item) => item.text),
    ['Water the plants'],
  )
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('what was kept shows again; ticking and removing change it', async () => {
  const view = await mountPanel(panel, {
    ...options,
    persisted: {
      workspace: {
        items: [
          { id: 'milk', text: 'Buy milk', done: false },
          { id: 'plumber', text: 'Call the plumber', done: false },
        ],
      },
    },
  })
  assert.ok(view.find({ text: '2 of 2 left' }))

  await view.toggle({ role: 'checkbox', label: 'Buy milk' })
  assert.ok(view.find({ text: '1 of 2 left' }))

  await view.press({ role: 'button', label: 'Remove Call the plumber' })
  assert.equal(view.find({ label: 'Call the plumber' }), null)
  assert.deepEqual(view.persisted.workspace.items, [{ id: 'milk', text: 'Buy milk', done: true }])
  await view.unmount()
})

test('a blank item is not added', async () => {
  const view = await mountPanel(panel, options)
  await view.type({ label: 'New item' }, '   ')
  await view.press({ role: 'button', text: 'Add' })
  assert.ok(view.find({ type: 'EmptyState' }))
  await view.unmount()
})
