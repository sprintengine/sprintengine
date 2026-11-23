// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { greetingFrom, saveGreeting } from '../extension/src/greeting'
import { manifest } from './manifest'

const surface = { point: 'settingsSections', id: 'greeting' } as const

test('the greeting follows the name and the tone', () => {
  assert.equal(greetingFrom({}), 'Hello, there.')
  assert.equal(greetingFrom({ name: ' Ada ', tone: 'warm' }), 'Good to see you, Ada!')
  assert.equal(greetingFrom({ name: 'Ada', tone: 'loud' }), 'Hello, Ada.')
})

test('the section greets with what was saved', async () => {
  const frame = createFakeFrameStudio({ manifest, settings: { name: 'Night shift', tone: 'warm' } })
  const saved = await frame.studio(surface).host.call('settings.get', {})
  assert.equal(greetingFrom(saved), 'Good to see you, Night shift!')
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('what the section saves Studio keeps, and an emptied name is cleared', async () => {
  const frame = createFakeFrameStudio({ manifest })
  const studio = frame.studio(surface)
  await saveGreeting(studio, 'tone', 'warm')
  await saveGreeting(studio, 'name', 'Ada')
  await saveGreeting(studio, 'name', '')
  assert.deepEqual(frame.settings(), { tone: 'warm' })
})

test('the command opens Settings without any code of its own', () => {
  assert.deepEqual(
    manifest.contributes.commands.map((command) => command.action),
    ['app.settings.open'],
  )
})
