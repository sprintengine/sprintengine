// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes,
// handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { GreetingSettings, greetingFrom } from '../src/greeting'
import { manifest } from './manifest'

test('the greeting follows the name and the tone', () => {
  assert.equal(greetingFrom({}), 'Hello, there.')
  assert.equal(greetingFrom({ name: ' Ada ', tone: 'warm' }), 'Good to see you, Ada!')
  assert.equal(greetingFrom({ name: 'Ada', tone: 'loud' }), 'Hello, Ada.')
})

test('the section shows what was saved', async () => {
  const renderer = createFakeRendererHost({ manifest, appState: { name: 'Night shift', tone: 'warm' } })
  const studio = renderer.studio({ point: 'settingsSections', id: 'greeting' })
  const html = await renderToHtml(createElement(GreetingSettings, { studio }))
  assert.match(html, /Good to see you, Night shift!/)
  assert.deepEqual(renderer.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('the command opens Settings without any code of its own', () => {
  assert.deepEqual(
    manifest.contributes.commands.map((command) => command.action),
    ['app.settings.open'],
  )
})
