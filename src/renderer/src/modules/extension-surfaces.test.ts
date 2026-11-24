import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  getExtensionSurface,
  readExtensionReadiness,
  recordReadiness,
  registerExtensionSurface,
  retireExtensionSurfaces,
} from './extension-surfaces'
import { createRendererHost } from './renderer-host'

// The surfaces approved extensions declare, as the shell holds them to draw
// in frames, and how long each took to be ready once opened.

test('a surface is registered under its extension’s key and leaves with it', () => {
  const host = createRendererHost().hostFor('acme.held')
  registerExtensionSurface({
    key: 'acme.held',
    point: 'doors',
    contribution: { id: 'board', title: 'Board', entry: 'dist/board.js' },
    host,
  })
  assert.equal(getExtensionSurface('acme.held', 'doors', 'board')?.contribution.title, 'Board')
  assert.equal(retireExtensionSurfaces('acme.held').length, 1)
  assert.equal(getExtensionSurface('acme.held', 'doors', 'board'), undefined)
})

test('readiness is kept per opening, with the frame’s first paint when it came first', () => {
  const mine = () => readExtensionReadiness().filter((entry) => entry.key === 'acme.ready')
  recordReadiness({ key: 'acme.ready', point: 'panels', id: 'notes', ms: 42, paintMs: 30 })
  recordReadiness({ key: 'acme.ready', point: 'panels', id: 'notes', ms: 12 })
  assert.deepEqual(
    mine().map((entry) => [entry.ms, entry.paintMs]),
    [
      [42, 30],
      [12, undefined],
    ],
  )
})
