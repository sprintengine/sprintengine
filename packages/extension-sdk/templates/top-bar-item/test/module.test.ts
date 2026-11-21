// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes,
// handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { FocusTimer, formatRemaining } from '../src/timer'
import { manifest } from './manifest'

const surface = { point: 'doors', id: 'timer' } as const

test('the top bar button opens the timer door', () => {
  assert.deepEqual(
    manifest.contributes.topBarItems.map((item) => item.door),
    ['timer'],
  )
  assert.deepEqual(
    manifest.contributes.doors.map((door) => door.id),
    ['timer'],
  )
})

test('with no timer running, the door offers to start one', async () => {
  const renderer = createFakeRendererHost({ manifest })
  const html = await renderToHtml(createElement(FocusTimer, { studio: renderer.studio(surface) }))
  assert.match(html, /Start 25 minutes of focus/)
  assert.deepEqual(renderer.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('a timer that ran out says so', async () => {
  const renderer = createFakeRendererHost({ manifest, appState: { focusEndsAt: Date.now() - 1000 } })
  const html = await renderToHtml(createElement(FocusTimer, { studio: renderer.studio(surface) }))
  assert.match(html, /Time is up/)
})

test('the time left reads as minutes and seconds', () => {
  assert.equal(formatRemaining(25 * 60_000), '25:00')
  assert.equal(formatRemaining(61_500), '1:02')
  assert.equal(formatRemaining(-5), '0:00')
})
