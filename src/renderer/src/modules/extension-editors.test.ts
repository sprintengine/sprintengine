import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import {
  TEXT_EDITOR_VIEW,
  chooseEditorView,
  extensionEditorViewId,
  extensionEditorsFor,
  resetEditorViewsForTests,
  resolveExtensionEditor,
} from './extension-editors'
import { registerExtensionSurface, retireExtensionSurfaces } from './extension-surfaces'
import type { InternalRendererHost } from './renderer-host'

// Which editor a file opens in: the best default match, an option only when
// chosen, and the text editor whenever the person asks for it.

const host = {} as InternalRendererHost
let on = true

function editor(key: string, id: string, more: Record<string, unknown>) {
  registerExtensionSurface({
    key,
    point: 'customEditors',
    contribution: { id, title: id, entry: `${id}.js`, ...more },
    host,
    live: () => on,
  })
}

afterEach(() => {
  retireExtensionSurfaces('local.todo')
  retireExtensionSurfaces('local.json-tools')
  resetEditorViewsForTests()
  on = true
})

test('a file opens in its best default editor; an option editor is only offered', () => {
  editor('local.todo', 'todo', { extensions: ['.todo', '.todo.json'] })
  editor('local.json-tools', 'tree', { extensions: ['.json'], priority: 'option' })
  const list = '/Users/dev/app/list.todo.json'
  const matches = extensionEditorsFor(list)
  assert.deepEqual(
    matches.map((match) => match.contribution.id),
    ['todo', 'tree'],
    'the longer suffix first',
  )
  assert.equal(resolveExtensionEditor('ws', list, matches)?.contribution.id, 'todo')

  const plain = '/Users/dev/app/package.json'
  const optionOnly = extensionEditorsFor(plain)
  assert.deepEqual(
    optionOnly.map((match) => match.contribution.id),
    ['tree'],
  )
  assert.equal(resolveExtensionEditor('ws', plain, optionOnly), null, 'an option opens in the text editor')
  chooseEditorView('ws', plain, extensionEditorViewId(optionOnly[0]!))
  assert.equal(resolveExtensionEditor('ws', plain, optionOnly)?.contribution.id, 'tree')
})

test('an editor for a file Studio’s text editor is for is only offered', () => {
  editor('local.json-tools', 'tree', { extensions: ['.json'] })
  const plain = '/Users/dev/app/package.json'
  assert.equal(extensionEditorsFor(plain).length, 1)
  assert.equal(resolveExtensionEditor('ws', plain, extensionEditorsFor(plain)), null)
})

test('the person can always reopen a file in the text editor, for that file only', () => {
  editor('local.todo', 'todo', { extensions: ['.todo'] })
  const a = '/Users/dev/app/a.todo'
  const b = '/Users/dev/app/b.todo'
  chooseEditorView('ws', a, TEXT_EDITOR_VIEW)
  assert.equal(resolveExtensionEditor('ws', a, extensionEditorsFor(a)), null)
  assert.equal(resolveExtensionEditor('ws', b, extensionEditorsFor(b))?.contribution.id, 'todo')
})

test('an extension switched off opens nothing', () => {
  editor('local.todo', 'todo', { extensions: ['.todo'] })
  on = false
  assert.deepEqual(extensionEditorsFor('/Users/dev/app/a.todo'), [])
})
