import { expect, test } from 'vitest'

import { installState, listingCategories, listingMatches } from './extensionCatalogueModel'

const listing = {
  id: 'acme.notes',
  name: 'Notes',
  publisher: 'acme',
  description: 'Take notes beside your chats.',
  categories: ['productivity', 'writing'],
  version: '1.1.0',
  installable: true,
  tier: 'ui' as const,
  permissions: [],
  contributes: [],
  label: 'Community · acme',
}

test('search matches every word, and a category narrows', () => {
  expect(listingMatches(listing, 'notes chats', null)).toBe(true)
  expect(listingMatches(listing, 'notes deploy', null)).toBe(false)
  expect(listingMatches(listing, '', 'writing')).toBe(true)
  expect(listingMatches(listing, '', 'themes')).toBe(false)
  expect(listingCategories([listing, { ...listing, categories: ['writing'] }])).toEqual(['writing', 'productivity'])
})

test('the page offers install, update, or says why not', () => {
  expect(installState(listing)).toEqual({ kind: 'install' })
  expect(installState({ ...listing, installed: { version: '1.0.0', fromHere: true } })).toEqual({
    kind: 'update',
    version: '1.1.0',
  })
  expect(installState({ ...listing, installed: { version: '1.1.0', fromHere: true } })).toEqual({ kind: 'installed' })
  expect(installState({ ...listing, installed: { version: '1.0.0', fromHere: false } })).toEqual({ kind: 'elsewhere' })
  expect(installState({ ...listing, installable: false, needsStudio: '9.0.0' })).toEqual({
    kind: 'blocked',
    words: 'Needs Studio 9.0.0',
  })
  expect(installState({ ...listing, killed: { reason: 'x' } }).kind).toBe('blocked')
})
