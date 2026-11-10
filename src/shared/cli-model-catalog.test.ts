import assert from 'node:assert/strict'
import { test } from 'vitest'

import { cliModelListing, mergeCliModelCatalog, type DiscoveredCliModelCatalog } from './cli-model-catalog'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const SEED = {
  options: [
    { id: 'seed-a', label: 'Seed A' },
    { id: 'seed-b', label: 'Seed B' },
  ],
  allowCustomId: true,
}
const reported = (...ids: string[]): DiscoveredCliModelCatalog => ({
  models: ids.map((id) => ({ id, displayName: id.toUpperCase() })),
  fetchedAt: '2026-11-01T11:00:00Z',
  source: 'argv-probe',
})
const ids = (catalog: ReturnType<typeof mergeCliModelCatalog>) => catalog?.options.map((option) => option.id)

test('a removed id leaves the CLI’s rows and the seed, in every picker’s merge', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(SEED, undefined, reported('a', 'b'), NOW, ['a'])), ['b'])
  assert.deepEqual(ids(mergeCliModelCatalog(SEED, undefined, undefined, NOW, ['seed-a'])), ['seed-b'])
})

test('a refresh that lists a removed id again does not bring it back', () => {
  const before = mergeCliModelCatalog(SEED, ['mine'], reported('a', 'b'), NOW, ['a'])
  const after = mergeCliModelCatalog(SEED, ['mine'], reported('a', 'b', 'c'), NOW, ['a'])
  assert.deepEqual(ids(before), ['b', 'mine'])
  assert.deepEqual(ids(after), ['b', 'c', 'mine'], 'the typed id survives the replaced list too')
})

test('removing every reported row leaves an empty list, not the seed standing in', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(SEED, undefined, reported('a'), NOW, ['a'])), [])
})

test('an id the person also typed is still offered', () => {
  const merged = mergeCliModelCatalog(SEED, ['a'], reported('a', 'b'), NOW, ['a'])
  assert.deepEqual(ids(merged), ['b', 'a'])
  assert.equal(merged?.options.find((option) => option.id === 'a')?.origin, 'user')
})

test('with no answer at all, typed ids follow the seed', () => {
  assert.deepEqual(ids(mergeCliModelCatalog(SEED, ['mine'], undefined, NOW)), ['seed-a', 'seed-b', 'mine'])
})

test('the listing Settings edits names what can be restored, with the CLI’s own label', () => {
  const listing = cliModelListing(SEED, ['mine'], reported('a', 'b'), NOW, ['a', 'gone-from-the-cli'])
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
