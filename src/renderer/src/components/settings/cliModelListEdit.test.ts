import assert from 'node:assert/strict'
import { test } from 'vitest'

import { addTypedModel, removeListedModel, restoreListedModel, type CliModelEdit } from './cliModelListEdit'

const EMPTY: CliModelEdit = { models: [], removedModels: [] }
const listed = new Set(['opus', 'mine'])

const refused = (raw: string, edit = EMPTY) => {
  const result = addTypedModel(raw, edit, listed, 'Claude Code')
  assert.equal(result.ok, false, raw)
  return result.ok ? '' : result.reason
}

test('a typed id is trimmed and added', () => {
  const result = addTypedModel('  claude-opus-5-5[1m] ', EMPTY, listed, 'Claude Code')
  assert.deepEqual(result, {
    ok: true,
    id: 'claude-opus-5-5[1m]',
    restored: false,
    edit: { models: ['claude-opus-5-5[1m]'], removedModels: [] },
  })
})

test('a provider-prefixed id is a valid id', () => {
  assert.equal(addTypedModel('acme/model-1', EMPTY, listed, 'OpenCode').ok, true)
})

test('empty input, spaces, a leading dash and an overlong id are refused in words', () => {
  assert.equal(refused('   '), 'Type a model id first.')
  assert.equal(refused('two words'), 'A model id has no spaces in it.')
  assert.equal(refused('--dangerous'), 'A model id cannot start with a dash.')
  assert.match(refused('x'.repeat(201)), /at most 200/)
})

test('a duplicate is refused and names the list it is already on', () => {
  assert.equal(refused(' opus '), "opus is already in Claude Code's list.")
})

test('typing a removed id puts the CLI’s own row back rather than storing a copy', () => {
  const result = addTypedModel('sonnet', { models: [], removedModels: ['sonnet'] }, listed, 'Claude Code')
  assert.deepEqual(result, { ok: true, id: 'sonnet', restored: true, edit: { models: [], removedModels: [] } })
})

test('removing an id only the person typed forgets it', () => {
  const next = removeListedModel({ models: ['mine'], removedModels: [] }, 'mine', new Set(['opus']))
  assert.deepEqual(next, { models: [], removedModels: [] })
})

test('removing a reported id remembers it, so a refresh cannot bring it back', () => {
  const next = removeListedModel(EMPTY, 'opus', new Set(['opus']))
  assert.deepEqual(next, { models: [], removedModels: ['opus'] })
  assert.deepEqual(removeListedModel(next, 'opus', new Set(['opus'])), next, 'removing twice stores it once')
})

test('removing an id both typed and reported drops the copy and remembers the removal', () => {
  const next = removeListedModel({ models: ['opus'], removedModels: [] }, 'opus', new Set(['opus']))
  assert.deepEqual(next, { models: [], removedModels: ['opus'] })
})

test('restore takes an id off the removed list and touches nothing else', () => {
  assert.deepEqual(restoreListedModel({ models: ['mine'], removedModels: ['opus', 'haiku'] }, 'opus'), {
    models: ['mine'],
    removedModels: ['haiku'],
  })
})
