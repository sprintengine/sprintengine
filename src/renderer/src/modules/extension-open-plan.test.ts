import assert from 'node:assert/strict'

import { test } from 'vitest'

import { planExtensionOpen, type ExtensionOpenContext } from './extension-open-plan'

// What a window does with an `extension.open` ask, decided from what the
// window has: the workspace it shows, the panels and custom editors loaded.

const KEY = 'local.weather-deck'

function context(overrides: Partial<ExtensionOpenContext> = {}): ExtensionOpenContext {
  return {
    activeWorkspaceId: 'ws-1',
    panelsOf: (moduleId) =>
      moduleId === KEY
        ? [
            { id: 'forecast', title: 'Forecast' },
            { id: 'radar', title: 'Radar' },
          ]
        : [],
    editorViewsFor: (file) => (file.endsWith('.deck') ? ['local.other/deck', `${KEY}/deck`, `${KEY}/deck-raw`] : []),
    ...overrides,
  }
}

test('a window showing no workspace says no_workspace, whatever was asked', () => {
  for (const request of [{ moduleId: KEY }, { moduleId: KEY, panel: 'radar' }, { moduleId: KEY, file: '/a.deck' }]) {
    const plan = planExtensionOpen(request, context({ activeWorkspaceId: null }))
    assert.equal(plan.kind, 'refuse')
    assert.equal(plan.kind === 'refuse' && plan.outcome.code, 'no_workspace')
  }
})

test('a named panel opens in the active workspace, under the asked title or its own', () => {
  assert.deepEqual(planExtensionOpen({ moduleId: KEY, panel: 'radar' }, context()), {
    kind: 'panel',
    workspaceId: 'ws-1',
    moduleId: KEY,
    panel: 'radar',
    title: 'Radar',
  })
  const titled = planExtensionOpen({ moduleId: KEY, panel: 'radar', title: 'Rain radar' }, context())
  assert.equal(titled.kind === 'panel' && titled.title, 'Rain radar')
})

test('neither a panel nor a file named opens the extension’s first panel', () => {
  const plan = planExtensionOpen({ moduleId: KEY }, context())
  assert.equal(plan.kind === 'panel' && plan.panel, 'forecast')
})

test('a panel this window has not loaded, or an extension with none, is not_found', () => {
  const missing = planExtensionOpen({ moduleId: KEY, panel: 'tides' }, context())
  assert.equal(missing.kind === 'refuse' && missing.outcome.code, 'not_found')
  assert.match(missing.kind === 'refuse' ? missing.outcome.message : '', /tides/u)
  const none = planExtensionOpen({ moduleId: 'local.other' }, context())
  assert.equal(none.kind === 'refuse' && none.outcome.code, 'not_found')
})

test('a file opens in the named custom editor of this extension, never another’s', () => {
  assert.deepEqual(
    planExtensionOpen({ moduleId: KEY, file: '/Users/dev/notes/week.deck', editor: 'deck-raw' }, context()),
    {
      kind: 'file',
      workspaceId: 'ws-1',
      file: '/Users/dev/notes/week.deck',
      name: 'week.deck',
      viewId: `${KEY}/deck-raw`,
    },
  )
  // No editor named: this extension's best match, not the other extension's
  // that ranks above it.
  const best = planExtensionOpen({ moduleId: KEY, file: 'C:\\Users\\dev\\week.deck' }, context())
  assert.equal(best.kind === 'file' && best.viewId, `${KEY}/deck`)
  assert.equal(best.kind === 'file' && best.name, 'week.deck')
})

test('a file no loaded editor of this extension opens is not_found', () => {
  const wrongEditor = planExtensionOpen({ moduleId: KEY, file: '/Users/dev/a.deck', editor: 'slides' }, context())
  assert.equal(wrongEditor.kind === 'refuse' && wrongEditor.outcome.code, 'not_found')
  const wrongFile = planExtensionOpen({ moduleId: KEY, file: '/Users/dev/a.txt', editor: 'deck' }, context())
  assert.equal(wrongFile.kind === 'refuse' && wrongFile.outcome.code, 'not_found')
  const otherExtension = planExtensionOpen({ moduleId: 'local.third', file: '/Users/dev/a.deck' }, context())
  assert.equal(otherExtension.kind === 'refuse' && otherExtension.outcome.code, 'not_found')
})
