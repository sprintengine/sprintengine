import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { createTrustTokenStore, TRUST_TOKEN_TTL_MS, trustPinsMatch, type TrustPin } from './trust-tokens'

const PIN: TrustPin = {
  manifestSha256: 'b'.repeat(64),
  componentDigests: { 'skills/review': 'c'.repeat(64) },
}

const ENTRY = {
  id: 'review-skills',
  name: 'Review skills',
  publisher: { name: 'acme', verified: false },
  summary: 'A Claude Code plugin.',
  category: 'dev-tools',
  icon: '',
  latest: 1,
  provides: ['skills'],
  tags: ['claude-plugin'],
  source: 'https://github.com/acme/review-skills',
} as MarketplacePluginEntry

test('a token is spent once, and only for the entry it names', () => {
  const store = createTrustTokenStore()
  const token = store.issue({ entryId: 'plugin-a', pin: PIN })

  const grant = store.consume(token, 'plugin-a')
  assert.deepEqual(grant, { entryId: 'plugin-a', pin: PIN })
  assert.equal(store.consume(token, 'plugin-a'), null, 'a second install cannot reuse the approval')

  // Presented for another entry: refused, and burned, so it cannot then be
  // replayed for the entry it was issued for.
  const other = store.issue({ entryId: 'plugin-a', pin: PIN })
  assert.equal(store.consume(other, 'plugin-b'), null)
  assert.equal(store.consume(other, 'plugin-a'), null)

  assert.equal(store.consume('made-up', 'plugin-a'), null)
  assert.equal(store.consume('', 'plugin-a'), null)
})

test('a token expires ten minutes after the prompt', () => {
  let now = 1_000
  const store = createTrustTokenStore({ now: () => now })
  const live = store.issue({ entryId: 'plugin-a', pin: PIN })
  const expired = store.issue({ entryId: 'plugin-a', pin: PIN })
  now += TRUST_TOKEN_TTL_MS - 1
  assert.ok(store.consume(live, 'plugin-a'))
  now += 1
  assert.equal(store.consume(expired, 'plugin-a'), null)
})

test('the entry the review read rides in its grant', () => {
  const store = createTrustTokenStore()
  const token = store.issue({ entryId: ENTRY.id, pin: PIN, entry: ENTRY })
  // A registry refresh between the prompt and the click cannot change what installs.
  assert.deepEqual(store.consume(token, ENTRY.id)?.entry, ENTRY)
})

test('the issued pin cannot be changed by the caller afterwards', () => {
  const store = createTrustTokenStore()
  const pin: TrustPin = { manifestSha256: 'b'.repeat(64), componentDigests: { a: '1' } }
  const token = store.issue({ entryId: 'plugin-a', pin })
  pin.componentDigests.a = '2'
  assert.equal(store.consume(token, 'plugin-a')?.pin.componentDigests.a, '1')
})

test('pins match on content', () => {
  assert.equal(trustPinsMatch(PIN, { ...PIN }), true)
  assert.equal(trustPinsMatch(PIN, { ...PIN, manifestSha256: 'd'.repeat(64) }), false)
  assert.equal(trustPinsMatch(PIN, { ...PIN, componentDigests: { 'skills/review': 'e'.repeat(64) } }), false)
  assert.equal(
    trustPinsMatch(PIN, { ...PIN, componentDigests: { ...PIN.componentDigests, 'skills/extra': 'f' } }),
    false,
    'a skill the prompt never listed',
  )
  assert.equal(trustPinsMatch(PIN, { ...PIN, componentDigests: {} }), false)
})
