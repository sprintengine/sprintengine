// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes,
// handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { NotesPanel } from '../src/notes'
import { manifest } from './manifest'

const surface = { point: 'panels', id: 'notes', workspaceId: 'ws-app' } as const

test('the panel shows what was saved', async () => {
  const renderer = createFakeRendererHost({ manifest, appState: { notes: 'Buy milk' } })
  const html = await renderToHtml(createElement(NotesPanel, { studio: renderer.studio(surface) }))
  assert.match(html, /Buy milk/)
  assert.match(html, /Saved/)
  assert.deepEqual(renderer.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('what the panel saves is there for every window', () => {
  const renderer = createFakeRendererHost({ manifest })
  const studio = renderer.studio(surface)
  const heard: unknown[] = []
  studio.watchModuleAppState((values) => heard.push(values.notes))
  assert.equal(studio.setModuleAppState('notes', 'Call the plumber'), true)
  assert.deepEqual(renderer.appState(), { notes: 'Call the plumber' })
  assert.equal(heard.at(-1), 'Call the plumber', 'a watcher hears the change')
})
