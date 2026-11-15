import assert from 'node:assert/strict'
import { test } from 'vitest'

import { cliModelListing, mergeCliModelCatalog, type DiscoveredCliModelCatalog } from './cli-model-catalog'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const DECLARED = { allowCustomId: true }
const reported = (...ids: string[]): DiscoveredCliModelCatalog => ({
  models: ids.map((id) => ({ id, displayName: id.toUpperCase() })),
  fetchedAt: '2026-11-01T11:00:00Z',
  source: 'argv-probe',
})
const ids = (catalog: ReturnType<typeof mergeCliModelCatalog>) => catalog?.options.map((option) => option.id)

test('a removed id leaves the CLI’s rows, in every picker’s merge', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(DECLARED, undefined, reported('a', 'b'), NOW, ['a'])), ['b'])
})

test('a refresh that lists a removed id again does not bring it back', () => {
  const before = mergeCliModelCatalog(DECLARED, ['mine'], reported('a', 'b'), NOW, ['a'])
  const after = mergeCliModelCatalog(DECLARED, ['mine'], reported('a', 'b', 'c'), NOW, ['a'])
  assert.deepEqual(ids(before), ['b', 'mine'])
  assert.deepEqual(ids(after), ['b', 'c', 'mine'], 'the typed id survives the replaced list too')
})

test('removing every reported row leaves an empty list', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(DECLARED, undefined, reported('a'), NOW, ['a'])), [])
})

test('an id the person also typed is still offered', () => {
  const merged = mergeCliModelCatalog(DECLARED, ['a'], reported('a', 'b'), NOW, ['a'])
  assert.deepEqual(ids(merged), ['b', 'a'])
  assert.equal(merged?.options.find((option) => option.id === 'a')?.origin, 'user')
})

test('with no answer at all, the list is the typed ids alone', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(DECLARED, ['mine'], undefined, NOW)), ['mine'])
  assert.deepEqual(ids(mergeCliModelCatalog(DECLARED, undefined, undefined, NOW)), [], 'nothing is made up to fill it')
  assert.deepEqual(
    ids(mergeCliModelCatalog(DECLARED, ['mine'], reported(), NOW)),
    ['mine'],
    'an empty answer is no answer',
  )
})

test('the listing Settings edits names what can be restored, with the CLI’s own label', () => {
  const listing = cliModelListing(DECLARED, ['mine'], reported('a', 'b'), NOW, ['a', 'gone-from-the-cli'])
  assert.deepEqual(
    listing.listed.map((option) => option.id),
    ['b', 'mine'],
  )
  assert.deepEqual(listing.removed, [{ id: 'a', label: 'A' }], 'an id the CLI no longer reports has nothing to restore')
  assert.deepEqual([...listing.reportedIds], ['a', 'b'])
})

test('a CLI with no model selection has an empty listing', () => {
  const listing = cliModelListing(undefined, ['mine'], reported('a'), NOW, undefined)
  assert.deepEqual(listing.listed, [])
  assert.deepEqual(listing.removed, [])
})
